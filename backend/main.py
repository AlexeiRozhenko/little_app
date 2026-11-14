"""SAME PAGE — minimal FastAPI backend.

The browser uses Supabase only for sign-in. Every data request comes here
with the user's access token; we verify it, then read/write the database
with the service-role key while enforcing membership and reveal rules.
"""
import os
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field
from supabase import Client, create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Missing {name} in .env — copy .env.example to .env and fill it in.")
    return value


SUPABASE_URL = _env("SUPABASE_URL")
SUPABASE_ANON_KEY = _env("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY = _env("SUPABASE_SERVICE_ROLE_KEY")

BUCKET = "answer-media"
MAX_PHOTO_BYTES = 8 * 1024 * 1024
MAX_PHOTOS = 4
IMAGE_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

STAGES = ["initial_reaction", "during_answering", "after_reading"]
EMOTIONS = {
    "initial_reaction": ["Curious", "Excited", "Nostalgic", "Happy", "Surprised", "Confused",
                         "Thoughtful", "Sad", "Uncomfortable", "Inspired", "Calm", "Other"],
    "during_answering": ["Inspired", "Excited", "Nostalgic", "Happy", "Vulnerable", "Thoughtful",
                         "Confused", "Calm", "Sad", "Curious", "Other"],
    "after_reading": ["Warmth", "Surprise", "Admiration", "Empathy", "Happiness", "Nostalgia",
                      "Curiosity", "Inspiration", "Sadness", "Confusion", "Other"],
}
REACTION_EMOJIS = ["❤️", "😂", "🥹", "😮", "🤗", "✨"]
XP = {"answer": 10, "initial_reaction": 2, "during_answering": 2, "after_reading": 3,
      "photo": 3, "comment": 2}
LEVELS = [(0, "Just Started"), (100, "Getting Closer"), (250, "Same Frequency"),
          (500, "Memory Makers"), (1000, "Unbreakable Connection")]

DB_ERRORS = {
    "INVALID_INVITE": (404, "This invitation link is not valid."),
    "INVITE_EXPIRED": (410, "This invitation has expired. Ask your friend for a new link."),
    "ROOM_FULL": (409, "This room already has two people."),
    "ALREADY_IN_ROOM": (409, "You are already in a room."),
    "ALREADY_SUBMITTED": (409, "Your answer is already sent."),
    "NO_QUESTIONS": (500, "No active questions in the database. Run supabase/schema.sql."),
}

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
app = FastAPI(title="SAME PAGE")


# ---------------------------------------------------------------- helpers

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def one(query):
    rows = query.limit(1).execute().data
    return rows[0] if rows else None


def rpc(name: str, params: dict):
    try:
        return sb.rpc(name, params).execute().data
    except APIError as e:
        msg = str(e.message or e)
        for code, (status, text) in DB_ERRORS.items():
            if code in msg:
                raise HTTPException(status, text)
        raise


def check_uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise HTTPException(404, "Not found.")


def current_user(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Please sign in.")
    try:
        res = sb.auth.get_user(authorization.split(" ", 1)[1])
    except Exception:
        raise HTTPException(401, "Your session has expired. Please sign in again.")
    if not res or not res.user:
        raise HTTPException(401, "Please sign in.")
    return res.user


def ensure_profile(user) -> dict:
    p = one(sb.table("profiles").select("*").eq("id", user.id))
    if p:
        return p
    meta = user.user_metadata or {}
    name = (meta.get("display_name") or (user.email or "friend").split("@")[0])[:40]
    sb.table("profiles").upsert({"id": user.id, "display_name": name}).execute()
    return {"id": user.id, "display_name": name}


def my_room(uid: str) -> dict | None:
    m = one(sb.table("room_members").select("room_id,role").eq("user_id", uid).eq("is_active", True))
    if not m:
        return None
    room = one(sb.table("rooms").select("*").eq("id", m["room_id"]))
    room["role"] = m["role"]
    return room


def require_active_room(uid: str) -> dict:
    room = my_room(uid)
    if not room:
        raise HTTPException(400, "You are not in a room yet.")
    if room["status"] != "active":
        raise HTTPException(400, "Waiting for your friend to join the room.")
    return room


def partner_of(room_id: str, uid: str) -> str | None:
    rows = sb.table("room_members").select("user_id").eq("room_id", room_id).eq("is_active", True).execute().data
    return next((r["user_id"] for r in rows if r["user_id"] != uid), None)


def names_for(ids) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    rows = sb.table("profiles").select("id,display_name").in_("id", ids).execute().data
    return {r["id"]: r["display_name"] for r in rows}


def room_today(room: dict) -> date:
    return datetime.now(ZoneInfo(room["timezone"])).date()


def load_session(session_id: str, uid: str) -> tuple[dict, dict]:
    room = require_active_room(uid)
    s = one(sb.table("daily_sessions").select("*").eq("id", check_uuid(session_id)))
    if not s or s["room_id"] != room["id"]:
        raise HTTPException(404, "Not found.")
    return s, room


def get_answer(session_id: str, uid: str) -> dict | None:
    return one(sb.table("answers").select("*").eq("session_id", session_id).eq("user_id", uid))


def ensure_draft(s: dict, uid: str) -> dict:
    if s["status"] != "open":
        raise HTTPException(400, "This day is already revealed.")
    a = get_answer(s["id"], uid)
    if a is None:
        sb.table("answers").upsert(
            {"session_id": s["id"], "user_id": uid, "status": "draft"},
            on_conflict="session_id,user_id", ignore_duplicates=True).execute()
        a = get_answer(s["id"], uid)
    if a["status"] != "draft":
        raise HTTPException(400, "Your answer is already sent and locked.")
    return a


def signed_url(path: str) -> str | None:
    try:
        r = sb.storage.from_(BUCKET).create_signed_url(path, 3600)
        return r.get("signedUrl") or r.get("signedURL")
    except Exception:
        return None


def grant_xp(room_id: str, uid: str, event: str, ref: str) -> None:
    sb.table("xp_events").upsert(
        {"room_id": room_id, "user_id": uid, "event_type": event,
         "reference_id": ref, "points": XP[event]},
        on_conflict="user_id,event_type,reference_id", ignore_duplicates=True).execute()


def answer_bundle(session_id: str, uid: str) -> dict:
    a = get_answer(session_id, uid)
    media = []
    if a:
        rows = (sb.table("answer_media").select("id,caption,storage_path")
                .eq("answer_id", a["id"]).order("created_at").execute().data)
        media = [{"id": r["id"], "caption": r["caption"] or "", "url": signed_url(r["storage_path"])}
                 for r in rows]
    rows = (sb.table("emotional_checkins").select("stage,emotions,note")
            .eq("session_id", session_id).eq("user_id", uid).execute().data)
    by_stage = {r["stage"]: r for r in rows}
    checkins = {st: {"emotions": by_stage[st]["emotions"], "note": by_stage[st]["note"] or ""}
                for st in STAGES if st in by_stage}
    return {
        "text": (a or {}).get("text_content") or "",
        "status": a["status"] if a else "none",
        "submitted_at": (a or {}).get("submitted_at"),
        "media": media,
        "checkins": checkins,
    }


def session_view(s: dict, room: dict, uid: str) -> dict:
    """Everything the UI needs for one day. The partner's content is included
    ONLY after the session is revealed — this is the privacy gate."""
    pid = partner_of(room["id"], uid)
    names = names_for([uid, pid])
    q = one(sb.table("questions").select("text,description,category,depth").eq("id", s["question_id"]))
    partner_answer = (one(sb.table("answers").select("status").eq("session_id", s["id"]).eq("user_id", pid))
                      if pid else None)
    view = {
        "id": s["id"],
        "date": s["session_date"],
        "status": s["status"],
        "question": q,
        "me": answer_bundle(s["id"], uid),
        "my_name": names.get(uid, "You"),
        "partner_name": names.get(pid, "Your friend"),
        "partner_submitted": bool(partner_answer and partner_answer["status"] == "submitted"),
        "partner": None,
        "comments": [],
        "reactions": [],
        "reaction_choices": REACTION_EMOJIS,
    }
    if s["status"] == "revealed":
        if pid:
            view["partner"] = answer_bundle(s["id"], pid)
        rows = (sb.table("comments").select("id,user_id,content,created_at")
                .eq("session_id", s["id"]).order("created_at").execute().data)
        view["comments"] = [{"id": c["id"], "content": c["content"], "created_at": c["created_at"],
                             "author": names.get(c["user_id"], "Friend"), "mine": c["user_id"] == uid}
                            for c in rows]
        rows = sb.table("reactions").select("user_id,emoji").eq("session_id", s["id"]).execute().data
        view["reactions"] = [{"emoji": e,
                              "count": sum(1 for r in rows if r["emoji"] == e),
                              "mine": any(r["emoji"] == e and r["user_id"] == uid for r in rows)}
                             for e in REACTION_EMOJIS]
    return view


# ---------------------------------------------------------------- models

class ProfileIn(BaseModel):
    display_name: str = Field(min_length=1, max_length=40)


class RoomIn(BaseModel):
    name: str = Field(default="Our page", min_length=1, max_length=60)
    timezone: str = "Asia/Almaty"


class AnswerIn(BaseModel):
    text: str = Field(default="", max_length=5000)


class CheckinIn(BaseModel):
    emotions: list[str] = Field(min_length=1, max_length=3)
    note: str = Field(default="", max_length=300)


class CommentIn(BaseModel):
    content: str = Field(min_length=1, max_length=1000)


class ReactionIn(BaseModel):
    emoji: str


# ---------------------------------------------------------------- routes: account & room

@app.get("/api/config")
def config():
    # anon key is public by design; it cannot read any table (RLS, no policies)
    return {"supabase_url": SUPABASE_URL, "supabase_anon_key": SUPABASE_ANON_KEY}


# Usernames are mapped to internal, non-deliverable Supabase Auth email identifiers.
# Password hashes, access tokens and refresh tokens remain managed by Supabase Auth.
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,24}$")


class UsernameCredentials(BaseModel):
    username: str
    password: str


def internal_email(username: str) -> str:
    normalized = username.strip().lower()
    if not USERNAME_RE.fullmatch(normalized):
        raise HTTPException(400, "Username must be 3–24 characters: letters, numbers or underscore.")
    return normalized + "@users.example.com"


def user_session(email: str, password: str) -> dict:
    # A separate anon client avoids mutating the privileged service-role client session.
    try:
        client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        result = client.auth.sign_in_with_password({"email": email, "password": password})
        if not result.session:
            raise HTTPException(401, "Incorrect username or password.")
        return {"access_token": result.session.access_token,
                "refresh_token": result.session.refresh_token}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Incorrect username or password.")


@app.post("/api/auth/register")
def register_account(body: UsernameCredentials):
    email = internal_email(body.username)
    if len(body.password) < 8 or len(body.password) > 128:
        raise HTTPException(400, "Password must be between 8 and 128 characters.")
    username = body.username.strip().lower()
    try:
        # No actual email confirmation is sent: this identifier is internal only.
        sb.auth.admin.create_user({"email": email, "password": body.password,
                                   "email_confirm": True,
                                   "user_metadata": {"display_name": username}})
    except Exception:
        # Do not return raw provider errors or leak privileged backend internals.
        raise HTTPException(409, "Username unavailable or registration failed.")
    return user_session(email, body.password)


@app.post("/api/auth/login")
def login_account(body: UsernameCredentials):
    return user_session(internal_email(body.username), body.password)


@app.get("/api/me")
def me(user=Depends(current_user)):
    profile = ensure_profile(user)
    room = my_room(user.id)
    room_out = None
    if room:
        members = (sb.table("room_members").select("user_id,role")
                   .eq("room_id", room["id"]).eq("is_active", True).execute().data)
        names = names_for([m["user_id"] for m in members])
        invite = None
        if room["status"] == "pending" and room["role"] == "owner":
            inv = one(sb.table("invitations").select("token,expires_at").eq("room_id", room["id"])
                      .is_("accepted_at", "null").gt("expires_at", now_iso())
                      .order("created_at", desc=True))
            invite = inv["token"] if inv else None
        room_out = {
            "id": room["id"], "name": room["name"], "timezone": room["timezone"],
            "status": room["status"], "is_owner": room["role"] == "owner",
            "members": [{"display_name": names.get(m["user_id"], "?"), "role": m["role"],
                         "is_me": m["user_id"] == user.id} for m in members],
            "invite_token": invite,
        }
    return {"user": {"id": user.id, "username": (user.email or "").split("@")[0], "display_name": profile["display_name"]},
            "room": room_out}


@app.put("/api/profile")
def update_profile(body: ProfileIn, user=Depends(current_user)):
    sb.table("profiles").upsert({"id": user.id, "display_name": body.display_name.strip(),
                                 "updated_at": now_iso()}).execute()
    return me(user)


def _new_invite(room_id: str, uid: str) -> None:
    sb.table("invitations").insert({
        "room_id": room_id, "created_by": uid, "token": secrets.token_urlsafe(24),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
    }).execute()


@app.post("/api/rooms")
def create_room(body: RoomIn, user=Depends(current_user)):
    try:
        ZoneInfo(body.timezone)
    except Exception:
        raise HTTPException(400, "Unknown timezone.")
    if my_room(user.id):
        raise HTTPException(409, "You are already in a room.")
    room = sb.table("rooms").insert({"name": body.name.strip(), "timezone": body.timezone,
                                     "created_by": user.id}).execute().data[0]
    try:
        sb.table("room_members").insert({"room_id": room["id"], "user_id": user.id, "role": "owner"}).execute()
    except APIError:
        sb.table("rooms").delete().eq("id", room["id"]).execute()
        raise HTTPException(409, "You are already in a room.")
    _new_invite(room["id"], user.id)
    return me(user)


@app.post("/api/rooms/invite")
def regenerate_invite(user=Depends(current_user)):
    room = my_room(user.id)
    if not room or room["role"] != "owner" or room["status"] != "pending":
        raise HTTPException(400, "Only the owner of a room that is still waiting can create invites.")
    _new_invite(room["id"], user.id)
    return me(user)


@app.post("/api/invites/{token}/join")
def join(token: str, user=Depends(current_user)):
    ensure_profile(user)
    rpc("join_room", {"p_token": token[:200], "p_user_id": user.id})
    return me(user)


# ---------------------------------------------------------------- routes: daily flow

@app.get("/api/daily")
def daily(user=Depends(current_user)):
    room = require_active_room(user.id)
    rows = rpc("get_or_create_daily_session",
               {"p_room_id": room["id"], "p_date": room_today(room).isoformat()})
    return session_view(rows[0], room, user.id)


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, user=Depends(current_user)):
    s, room = load_session(session_id, user.id)
    return session_view(s, room, user.id)


@app.put("/api/sessions/{session_id}/answer")
def save_draft(session_id: str, body: AnswerIn, user=Depends(current_user)):
    s, room = load_session(session_id, user.id)
    a = ensure_draft(s, user.id)
    (sb.table("answers").update({"text_content": body.text, "updated_at": now_iso()})
     .eq("id", a["id"]).eq("status", "draft").execute())
    return session_view(s, room, user.id)


def _sniff_image(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@app.post("/api/sessions/{session_id}/media")
async def upload_photo(session_id: str, file: UploadFile = File(...), caption: str = Form(""),
                       user=Depends(current_user)):
    s, room = load_session(session_id, user.id)
    a = ensure_draft(s, user.id)
    count = sb.table("answer_media").select("id", count="exact").eq("answer_id", a["id"]).execute().count or 0
    if count >= MAX_PHOTOS:
        raise HTTPException(400, f"You can attach up to {MAX_PHOTOS} photos.")
    if Path(file.filename or "").suffix.lower() not in ALLOWED_SUFFIXES:
        raise HTTPException(400, "Only JPG, PNG or WebP photos are allowed.")
    data = await file.read(MAX_PHOTO_BYTES + 1)
    if len(data) > MAX_PHOTO_BYTES:
        raise HTTPException(400, "Photo is too large (max 8 MB).")
    mime = _sniff_image(data)  # trust the bytes, not the declared type
    if not mime:
        raise HTTPException(400, "This file doesn't look like a JPG, PNG or WebP image.")
    path = f"{room['id']}/{s['id']}/{user.id}/{uuid.uuid4()}.{IMAGE_EXT[mime]}"
    sb.storage.from_(BUCKET).upload(path, data, {"content-type": mime})
    sb.table("answer_media").insert({
        "answer_id": a["id"], "user_id": user.id, "media_type": "image", "storage_path": path,
        "caption": caption.strip()[:200] or None, "file_size": len(data), "mime_type": mime,
    }).execute()
    return session_view(s, room, user.id)


@app.delete("/api/media/{media_id}")
def delete_photo(media_id: str, user=Depends(current_user)):
    m = one(sb.table("answer_media").select("*").eq("id", check_uuid(media_id)).eq("user_id", user.id))
    if not m:
        raise HTTPException(404, "Not found.")
    a = one(sb.table("answers").select("session_id,status").eq("id", m["answer_id"]))
    s, room = load_session(a["session_id"], user.id)
    if a["status"] != "draft":
        raise HTTPException(400, "Your answer is already sent and locked.")
    sb.storage.from_(BUCKET).remove([m["storage_path"]])
    sb.table("answer_media").delete().eq("id", m["id"]).execute()
    return session_view(s, room, user.id)


@app.post("/api/sessions/{session_id}/submit")
def submit(session_id: str, body: AnswerIn, user=Depends(current_user)):
    s, room = load_session(session_id, user.id)
    a = ensure_draft(s, user.id)
    (sb.table("answers").update({"text_content": body.text, "updated_at": now_iso()})
     .eq("id", a["id"]).eq("status", "draft").execute())
    photos = sb.table("answer_media").select("id", count="exact").eq("answer_id", a["id"]).execute().count or 0
    if not body.text.strip() and not photos:
        raise HTTPException(400, "Write something or add a photo first.")
    rpc("submit_answer", {"p_session_id": s["id"], "p_user_id": user.id})
    grant_xp(room["id"], user.id, "answer", s["id"])
    if photos:
        grant_xp(room["id"], user.id, "photo", s["id"])
    s = one(sb.table("daily_sessions").select("*").eq("id", s["id"]))
    return session_view(s, room, user.id)


@app.put("/api/sessions/{session_id}/checkins/{stage}")
def save_checkin(session_id: str, stage: str, body: CheckinIn, user=Depends(current_user)):
    if stage not in EMOTIONS:
        raise HTTPException(404, "Unknown stage.")
    if any(e not in EMOTIONS[stage] for e in body.emotions):
        raise HTTPException(400, "Unknown emotion.")
    s, room = load_session(session_id, user.id)
    a = get_answer(s["id"], user.id)
    submitted = bool(a and a["status"] == "submitted")
    if stage == "initial_reaction" and submitted:
        raise HTTPException(400, "The first reaction is recorded before answering.")
    if stage == "during_answering" and not submitted:
        raise HTTPException(400, "Send your answer first.")
    if stage == "after_reading" and s["status"] != "revealed":
        raise HTTPException(400, "You can share this after the reveal.")
    sb.table("emotional_checkins").upsert(
        {"session_id": s["id"], "user_id": user.id, "stage": stage, "emotions": body.emotions,
         "note": body.note.strip() or None, "updated_at": now_iso()},
        on_conflict="session_id,user_id,stage").execute()
    grant_xp(room["id"], user.id, stage, s["id"])
    return session_view(s, room, user.id)


@app.post("/api/sessions/{session_id}/comments")
def add_comment(session_id: str, body: CommentIn, user=Depends(current_user)):
    s, room = load_session(session_id, user.id)
    if s["status"] != "revealed":
        raise HTTPException(400, "Comments open after the reveal.")
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "Comment is empty.")
    sb.table("comments").insert({"session_id": s["id"], "user_id": user.id, "content": content}).execute()
    grant_xp(room["id"], user.id, "comment", s["id"])  # once per day, no farming
    return session_view(s, room, user.id)


@app.post("/api/sessions/{session_id}/reactions")
def toggle_reaction(session_id: str, body: ReactionIn, user=Depends(current_user)):
    if body.emoji not in REACTION_EMOJIS:
        raise HTTPException(400, "Unknown reaction.")
    s, room = load_session(session_id, user.id)
    if s["status"] != "revealed":
        raise HTTPException(400, "Reactions open after the reveal.")
    existing = one(sb.table("reactions").select("id").eq("session_id", s["id"])
                   .eq("user_id", user.id).eq("emoji", body.emoji))
    if existing:
        sb.table("reactions").delete().eq("id", existing["id"]).execute()
    else:
        sb.table("reactions").insert({"session_id": s["id"], "user_id": user.id, "emoji": body.emoji}).execute()
    return session_view(s, room, user.id)


# ---------------------------------------------------------------- routes: archive & play

@app.get("/api/archive")
def archive(user=Depends(current_user)):
    room = require_active_room(user.id)
    rows = (sb.table("daily_sessions").select("id,session_date,questions(text,category,depth)")
            .eq("room_id", room["id"]).eq("status", "revealed")
            .order("session_date", desc=True).execute().data)
    return [{"id": r["id"], "date": r["session_date"], **(r.get("questions") or {})} for r in rows]


@app.get("/api/play")
def play(user=Depends(current_user)):
    room = require_active_room(user.id)
    rid = room["id"]
    events = sb.table("xp_events").select("user_id,points").eq("room_id", rid).execute().data
    total = sum(e["points"] for e in events)
    mine = sum(e["points"] for e in events if e["user_id"] == user.id)

    level_idx = max(i for i, (need, _) in enumerate(LEVELS) if total >= need)
    nxt = LEVELS[level_idx + 1][0] if level_idx + 1 < len(LEVELS) else None

    days = (sb.table("daily_sessions").select("session_date,questions(depth)")
            .eq("room_id", rid).eq("status", "revealed").execute().data)
    dates = sorted({date.fromisoformat(d["session_date"]) for d in days})
    done = set(dates)
    today = room_today(room)
    cur_day = today if today in done else today - timedelta(days=1)  # today isn't over yet
    current = 0
    while cur_day in done:
        current += 1
        cur_day -= timedelta(days=1)
    longest, run, prev = 0, 0, None
    for d in dates:
        run = run + 1 if prev and d - prev == timedelta(days=1) else 1
        longest, prev = max(longest, run), d

    photos = (sb.table("answer_media").select("id", count="exact")
              .like("storage_path", f"{rid}/*").execute().count or 0)
    deep = sum(1 for d in days if (d.get("questions") or {}).get("depth") == "deep")
    n = len(dates)
    achievements = [
        ("🌱", "First Page", "Complete your first shared day", n >= 1),
        ("📅", "First Week", "Complete seven shared days", n >= 7),
        ("📸", "Photo People", "Share 10 photos", photos >= 10),
        ("🌊", "Deep Talkers", "Complete 10 deep questions", deep >= 10),
        ("🔥", "On a Roll", "Reach a 5-day streak", longest >= 5),
        ("📚", "Memory Makers", "Save 20 shared memories", n >= 20),
    ]
    return {
        "total_xp": total, "my_xp": mine,
        "level": level_idx + 1, "level_name": LEVELS[level_idx][1],
        "level_floor": LEVELS[level_idx][0], "next_level_xp": nxt,
        "current_streak": current, "longest_streak": longest, "completed_days": n,
        "photos": photos,
        "achievements": [{"icon": i, "title": t, "description": d, "unlocked": u}
                         for i, t, d, u in achievements],
    }


# ---------------------------------------------------------------- frontend
# mounted last so /api/* routes win
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
