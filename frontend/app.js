/* SAME PAGE — Vue 3 without a build step.
   Supabase JS is used only for sign-in; all data goes through our /api. */
const { createApp, ref, computed, watch, onMounted, onUnmounted } = Vue;

let sb = null; // Supabase client, created after /api/config loads

async function api(path, { method = 'GET', body, form } = {}) {
  const { data } = await sb.auth.getSession();
  const headers = {};
  if (data.session) headers.Authorization = 'Bearer ' + data.session.access_token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = json.detail;
    throw new Error(typeof d === 'string' ? d : (Array.isArray(d) ? d[0]?.msg : 'Something went wrong'));
  }
  return json;
}

const EMOTIONS = {
  initial_reaction: ['Curious', 'Excited', 'Nostalgic', 'Happy', 'Surprised', 'Confused', 'Thoughtful', 'Sad', 'Uncomfortable', 'Inspired', 'Calm', 'Other'],
  during_answering: ['Inspired', 'Excited', 'Nostalgic', 'Happy', 'Vulnerable', 'Thoughtful', 'Confused', 'Calm', 'Sad', 'Curious', 'Other'],
  after_reading: ['Warmth', 'Surprise', 'Admiration', 'Empathy', 'Happiness', 'Nostalgia', 'Curiosity', 'Inspiration', 'Sadness', 'Confusion', 'Other'],
};
const EMOJI = {
  Curious: '🧐', Excited: '🤩', Nostalgic: '🕰️', Happy: '😊', Surprised: '😮', Confused: '😕', Thoughtful: '🤔',
  Sad: '😢', Uncomfortable: '😬', Inspired: '✨', Calm: '🌿', Other: '💭', Vulnerable: '🫶', Warmth: '🤗',
  Surprise: '😲', Admiration: '🌟', Empathy: '💞', Happiness: '😄', Nostalgia: '📼', Curiosity: '🔍',
  Inspiration: '💡', Sadness: '🥲', Confusion: '🌀',
};
const STAGE_LABEL = { initial_reaction: 'Seeing the question', during_answering: 'While answering', after_reading: 'After reading' };
const STAGE_PROMPT = {
  initial_reaction: 'Why did this question make you feel this way? (optional)',
  during_answering: 'Anything about how it felt to answer? (optional)',
  after_reading: 'A few words for your friend (optional)',
};
const TIMEZONES = ['Asia/Almaty', 'Asia/Tashkent', 'Europe/Moscow', 'Europe/Istanbul', 'Europe/Berlin', 'Europe/London',
  'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Tokyo', 'UTC'];

const prettyDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
const emotionText = (c) => c.emotions.map((e) => (EMOJI[e] || '') + ' ' + e).join(', ');

/* ------------------------------------------------------------ small pieces */

const EmotionPicker = {
  props: ['stage', 'value', 'busy'],
  emits: ['save'],
  setup(props, { emit }) {
    const sel = ref(props.value?.emotions?.[0] || '');
    const note = ref(props.value?.note || '');
    const editing = ref(!props.value);
    watch(() => props.value, (v) => { if (v) editing.value = false; });
    const save = () => emit('save', { emotions: [sel.value], note: note.value });
    return { sel, note, editing, save, list: EMOTIONS[props.stage], EMOJI, prompt: STAGE_PROMPT[props.stage], emotionText };
  },
  template: `
  <div>
    <div v-if="!editing && value" class="row between">
      <span>{{ emotionText(value) }} <span v-if="value.note" class="muted">— {{ value.note }}</span></span>
      <button class="link" @click="editing = true">Change</button>
    </div>
    <template v-else>
      <div class="chips">
        <button v-for="e in list" :key="e" class="chip" :class="{ on: sel === e }" @click="sel = sel === e ? '' : e">{{ EMOJI[e] }} {{ e }}</button>
      </div>
      <template v-if="sel">
        <input v-model="note" :placeholder="prompt" maxlength="300">
        <button class="btn small" :disabled="busy" @click="save">Save feeling</button>
      </template>
    </template>
  </div>`,
};

const AnswerCard = {
  props: ['title', 'a'],
  setup() { return { STAGE_LABEL, emotionText }; },
  template: `
  <div class="card answer-card">
    <div class="answer-title">{{ title }}</div>
    <p v-if="a.text" class="answer-text">{{ a.text }}</p>
    <div v-if="a.media.length" class="photos">
      <figure v-for="m in a.media" :key="m.id">
        <a :href="m.url" target="_blank" rel="noopener"><img :src="m.url" alt="Photo answer"></a>
        <figcaption v-if="m.caption">{{ m.caption }}</figcaption>
      </figure>
    </div>
    <ul v-if="Object.keys(a.checkins).length" class="feelings">
      <li v-for="(c, stage) in a.checkins" :key="stage">
        <span class="muted small">{{ STAGE_LABEL[stage] }}</span><br>
        {{ emotionText(c) }}<span v-if="c.note" class="muted"> — {{ c.note }}</span>
      </li>
    </ul>
  </div>`,
};

/* ------------------------------------------------------------ one day */

const SessionView = {
  components: { EmotionPicker, AnswerCard },
  props: ['view'],
  emits: ['update'],
  setup(props, { emit }) {
    const text = ref(props.view.me.text);
    watch(() => props.view.id, () => { text.value = props.view.me.text; });
    const busy = ref(false), err = ref(''), hint = ref(''), caption = ref(''), comment = ref('');
    const file = ref(null);
    const base = computed(() => '/sessions/' + props.view.id);
    const submitted = computed(() => props.view.me.status === 'submitted');
    const revealed = computed(() => props.view.status === 'revealed');

    const statusText = computed(() => {
      if (revealed.value) {
        const done = props.view.me.checkins.after_reading && props.view.partner?.checkins.after_reading;
        return done ? 'Today’s memory has been saved 📖' : 'Both answers are ready ✨';
      }
      if (submitted.value) return 'You’ve answered. Waiting for your friend.';
      return 'Waiting for your answer';
    });

    async function run(fn) {
      busy.value = true; err.value = '';
      try { await fn(); } catch (e) { err.value = e.message; } finally { busy.value = false; }
    }
    const saveDraft = () => {
      if (submitted.value || text.value === props.view.me.text) return;
      run(async () => {
        emit('update', await api(base.value + '/answer', { method: 'PUT', body: { text: text.value } }));
        hint.value = 'Draft saved ✓';
      });
    };
    const upload = () => run(async () => {
      const f = file.value?.files?.[0];
      if (!f) throw new Error('Choose a photo first.');
      if (f.size > 8 * 1024 * 1024) throw new Error('Photo is too large (max 8 MB).');
      const fd = new FormData();
      fd.append('file', f);
      fd.append('caption', caption.value);
      emit('update', await api(base.value + '/media', { method: 'POST', form: fd }));
      caption.value = ''; file.value.value = '';
    });
    const removeMedia = (id) => run(async () => emit('update', await api('/media/' + id, { method: 'DELETE' })));
    const submit = () => {
      if (!confirm('Send your answer? You won’t be able to edit it afterwards.')) return;
      run(async () => emit('update', await api(base.value + '/submit', { method: 'POST', body: { text: text.value } })));
    };
    const saveCheckin = (stage, payload) =>
      run(async () => emit('update', await api(base.value + '/checkins/' + stage, { method: 'PUT', body: payload })));
    const sendComment = () => run(async () => {
      if (!comment.value.trim()) return;
      emit('update', await api(base.value + '/comments', { method: 'POST', body: { content: comment.value } }));
      comment.value = '';
    });
    const react = (emoji) => run(async () => emit('update', await api(base.value + '/reactions', { method: 'POST', body: { emoji } })));

    return { text, busy, err, hint, caption, comment, file, submitted, revealed, statusText,
      saveDraft, upload, removeMedia, submit, saveCheckin, sendComment, react, prettyDate };
  },
  template: `
  <div class="stack">
    <div class="card question-card">
      <div class="meta">
        <span class="tag">{{ view.question.category }}</span>
        <span class="tag" :class="'depth-' + view.question.depth">{{ view.question.depth }}</span>
        <span class="muted small">{{ prettyDate(view.date) }}</span>
      </div>
      <h1 class="question">{{ view.question.text }}</h1>
      <p v-if="view.question.description" class="muted">{{ view.question.description }}</p>
      <div class="status-row">
        <span class="status"><span class="dot" :class="{ on: submitted }"></span>You</span>
        <span class="status"><span class="dot" :class="{ on: view.partner_submitted }"></span>{{ view.partner_name }}</span>
        <span class="pill">{{ statusText }}</span>
      </div>
    </div>

    <p v-if="err" class="error">{{ err }}</p>

    <!-- 1–3: before sending -->
    <template v-if="!submitted && !revealed">
      <div class="card">
        <h3>1 · First reaction <span class="muted small">optional</span></h3>
        <p class="muted small">How did you feel when you read the question?</p>
        <emotion-picker stage="initial_reaction" :value="view.me.checkins.initial_reaction" :busy="busy"
          @save="saveCheckin('initial_reaction', $event)" />
      </div>

      <div class="card">
        <h3>2 · Your answer</h3>
        <textarea v-model="text" rows="7" maxlength="5000" placeholder="Take your time…" @blur="saveDraft"></textarea>
        <div class="row between"><span class="muted small">{{ text.length }} / 5000</span><span class="muted small">{{ hint }}</span></div>

        <div v-if="view.me.media.length" class="photos">
          <figure v-for="m in view.me.media" :key="m.id">
            <img :src="m.url" alt="Your photo">
            <figcaption v-if="m.caption">{{ m.caption }}</figcaption>
            <button class="remove" title="Remove photo" :disabled="busy" @click="removeMedia(m.id)">×</button>
          </figure>
        </div>
        <div v-if="view.me.media.length < 4" class="upload">
          <input type="file" ref="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp">
          <input v-model="caption" placeholder="Photo caption (optional)" maxlength="200">
          <button class="btn ghost" :disabled="busy" @click="upload">📷 Add photo</button>
        </div>
      </div>

      <div class="card">
        <h3>3 · Preview & send</h3>
        <blockquote v-if="text.trim()" class="preview">{{ text }}</blockquote>
        <p class="muted small">Once sent, your answer is locked. {{ view.partner_name }} will only see it after answering too.</p>
        <button class="btn primary wide" :disabled="busy || (!text.trim() && !view.me.media.length)" @click="submit">Send my answer</button>
      </div>
    </template>

    <!-- 4: waiting -->
    <template v-else-if="!revealed">
      <div class="card center waiting">
        <div class="big">💌</div>
        <h3>Your answer is sealed.</h3>
        <p class="muted">Waiting for {{ view.partner_name }}… This page refreshes by itself.</p>
      </div>
      <div class="card">
        <h3>How did it feel to answer? <span class="muted small">optional</span></h3>
        <emotion-picker stage="during_answering" :value="view.me.checkins.during_answering" :busy="busy"
          @save="saveCheckin('during_answering', $event)" />
      </div>
      <answer-card title="Your answer" :a="view.me" />
    </template>

    <!-- 5–7: reveal -->
    <template v-else>
      <div class="reveal-grid">
        <answer-card class="flip" :title="'You'" :a="view.me" />
        <answer-card v-if="view.partner" class="flip second" :title="view.partner_name" :a="view.partner" />
      </div>

      <div v-if="submitted && !view.me.checkins.during_answering" class="card">
        <h3>How did it feel to answer? <span class="muted small">optional</span></h3>
        <emotion-picker stage="during_answering" :value="null" :busy="busy" @save="saveCheckin('during_answering', $event)" />
      </div>

      <div class="card">
        <h3>After reading {{ view.partner_name }}’s answer</h3>
        <emotion-picker stage="after_reading" :value="view.me.checkins.after_reading" :busy="busy"
          @save="saveCheckin('after_reading', $event)" />
      </div>

      <div class="card">
        <div class="reactions">
          <button v-for="r in view.reactions" :key="r.emoji" class="chip" :class="{ on: r.mine }" :disabled="busy" @click="react(r.emoji)">
            {{ r.emoji }} <span v-if="r.count">{{ r.count }}</span>
          </button>
        </div>
        <ul class="comments">
          <li v-for="c in view.comments" :key="c.id" :class="{ mine: c.mine }">
            <span class="muted small">{{ c.author }}</span>
            <div>{{ c.content }}</div>
          </li>
        </ul>
        <div class="row">
          <input v-model="comment" placeholder="Comment or ask a follow-up…" maxlength="1000" @keyup.enter="sendComment">
          <button class="btn" :disabled="busy || !comment.trim()" @click="sendComment">Send</button>
        </div>
      </div>
    </template>
  </div>`,
};

/* ------------------------------------------------------------ pages */

const DailyPage = {
  components: { SessionView },
  props: ['name'],
  setup() {
    const view = ref(null), err = ref(''), loading = ref(true);
    let timer = null;
    const load = async (silent) => {
      try { view.value = await api('/daily'); err.value = ''; }
      catch (e) { if (!silent) err.value = e.message; }
      finally { loading.value = false; }
    };
    onMounted(() => {
      load();
      timer = setInterval(() => { if (!document.hidden) load(true); }, 10000); // simple "realtime"
    });
    onUnmounted(() => clearInterval(timer));
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return { view, err, loading, greeting };
  },
  template: `
  <div>
    <p class="greeting">{{ greeting }}, <b>{{ name }}</b> 👋</p>
    <p v-if="loading" class="muted center">Loading today’s question…</p>
    <p v-else-if="err" class="error">{{ err }}</p>
    <session-view v-else-if="view" :view="view" @update="view = $event" />
  </div>`,
};

const ArchivePage = {
  components: { SessionView },
  setup() {
    const items = ref([]), loading = ref(true), err = ref(''), q = ref(''), cat = ref('');
    const detail = ref(null);
    onMounted(async () => {
      try { items.value = await api('/archive'); } catch (e) { err.value = e.message; } finally { loading.value = false; }
    });
    const categories = computed(() => [...new Set(items.value.map((i) => i.category))].sort());
    const filtered = computed(() => items.value.filter((i) =>
      (!cat.value || i.category === cat.value) && i.text.toLowerCase().includes(q.value.toLowerCase())));
    const open = async (id) => {
      try { detail.value = await api('/sessions/' + id); window.scrollTo(0, 0); } catch (e) { err.value = e.message; }
    };
    return { items, loading, err, q, cat, detail, categories, filtered, open, prettyDate };
  },
  template: `
  <div>
    <template v-if="detail">
      <button class="link back" @click="detail = null">← Back to archive</button>
      <session-view :view="detail" @update="detail = $event" />
    </template>
    <template v-else>
      <h2>Archive</h2>
      <div class="row filters">
        <input v-model="q" placeholder="Search questions…">
        <select v-model="cat"><option value="">All categories</option><option v-for="c in categories" :key="c">{{ c }}</option></select>
      </div>
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="err" class="error">{{ err }}</p>
      <div v-else-if="!items.length" class="card center"><div class="big">📖</div><p class="muted">Your shared memories will appear here after your first reveal.</p></div>
      <div v-else class="stack">
        <button v-for="i in filtered" :key="i.id" class="card memory" @click="open(i.id)">
          <span class="muted small">{{ prettyDate(i.date) }} · {{ i.category }} · {{ i.depth }}</span>
          <span class="memory-q">{{ i.text }}</span>
        </button>
        <p v-if="!filtered.length" class="muted">Nothing matches.</p>
      </div>
    </template>
  </div>`,
};

const PlayPage = {
  setup() {
    const p = ref(null), err = ref('');
    onMounted(async () => { try { p.value = await api('/play'); } catch (e) { err.value = e.message; } });
    const progress = computed(() => {
      if (!p.value || !p.value.next_level_xp) return 100;
      return Math.round(100 * (p.value.total_xp - p.value.level_floor) / (p.value.next_level_xp - p.value.level_floor));
    });
    return { p, err, progress };
  },
  template: `
  <div>
    <h2>Play</h2>
    <p v-if="err" class="error">{{ err }}</p>
    <div v-else-if="!p" class="muted">Loading…</div>
    <div v-else class="stack">
      <div class="card level">
        <span class="muted small">Duo level {{ p.level }}</span>
        <h3>{{ p.level_name }}</h3>
        <div class="bar"><div :style="{ width: progress + '%' }"></div></div>
        <span class="muted small">{{ p.total_xp }} XP together<span v-if="p.next_level_xp"> · next level at {{ p.next_level_xp }}</span> · you earned {{ p.my_xp }}</span>
      </div>
      <div class="stats">
        <div class="card stat"><b>🔥 {{ p.current_streak }}</b><span class="muted small">current streak</span></div>
        <div class="card stat"><b>{{ p.longest_streak }}</b><span class="muted small">longest streak</span></div>
        <div class="card stat"><b>{{ p.completed_days }}</b><span class="muted small">shared days</span></div>
      </div>
      <p class="muted small center">Missed a day? No worries — streaks are just for fun.</p>
      <h3>Achievements</h3>
      <div class="achievements">
        <div v-for="a in p.achievements" :key="a.title" class="card ach" :class="{ locked: !a.unlocked }">
          <div class="big">{{ a.icon }}</div><b>{{ a.title }}</b><span class="muted small">{{ a.description }}</span>
        </div>
      </div>
    </div>
  </div>`,
};

const ProfilePage = {
  props: ['me'],
  emits: ['reload', 'signout'],
  setup(props, { emit }) {
    const name = ref(props.me.user.display_name), msg = ref(''), err = ref('');
    const save = async () => {
      try { await api('/profile', { method: 'PUT', body: { display_name: name.value } }); msg.value = 'Saved ✓'; emit('reload'); }
      catch (e) { err.value = e.message; }
    };
    return { name, msg, err, save };
  },
  template: `
  <div class="stack">
    <h2>Profile</h2>
    <div class="card">
      <label>Display name</label>
      <div class="row"><input v-model="name" maxlength="40"><button class="btn" @click="save">Save</button></div>
      <p class="muted small">{{ me.user.email }} <span v-if="msg">· {{ msg }}</span></p>
      <p v-if="err" class="error">{{ err }}</p>
    </div>
    <div class="card">
      <label>Your room</label>
      <h3>{{ me.room.name }}</h3>
      <p class="muted small">Day changes at midnight · {{ me.room.timezone }}</p>
      <ul class="members"><li v-for="m in me.room.members" :key="m.display_name">{{ m.display_name }} <span class="muted small">{{ m.is_me ? '(you)' : '' }} {{ m.role }}</span></li></ul>
    </div>
    <button class="btn ghost wide" @click="$emit('signout')">Sign out</button>
  </div>`,
};

/* ------------------------------------------------------------ before the app */

const AuthScreen = {
  setup() {
    const mode = ref('login'), email = ref(''), password = ref(''), name = ref('');
    const err = ref(''), msg = ref(''), busy = ref(false);
    const submit = async () => {
      err.value = ''; msg.value = ''; busy.value = true;
      try {
        if (mode.value === 'login') {
          const { error } = await sb.auth.signInWithPassword({ email: email.value, password: password.value });
          if (error) throw error;
        } else if (mode.value === 'register') {
          const { data, error } = await sb.auth.signUp({ email: email.value, password: password.value,
            options: { data: { display_name: name.value } } });
          if (error) throw error;
          if (!data.session) msg.value = 'Check your inbox to confirm your email, then log in.';
        } else {
          const { error } = await sb.auth.resetPasswordForEmail(email.value, { redirectTo: location.origin });
          if (error) throw error;
          msg.value = 'If this email exists, a reset link is on its way.';
        }
      } catch (e) { err.value = e.message; } finally { busy.value = false; }
    };
    return { mode, email, password, name, err, msg, busy, submit };
  },
  template: `
  <div class="auth">
    <div class="logo big-logo">SAME PAGE</div>
    <p class="muted center">A little game. A lot of connection.</p>
    <form class="card stack" @submit.prevent="submit">
      <div class="tabs">
        <button type="button" :class="{ on: mode === 'login' }" @click="mode = 'login'">Log in</button>
        <button type="button" :class="{ on: mode === 'register' }" @click="mode = 'register'">Sign up</button>
      </div>
      <input v-if="mode === 'register'" v-model="name" placeholder="Your name" required maxlength="40">
      <input v-model="email" type="email" placeholder="Email" required autocomplete="email">
      <input v-if="mode !== 'forgot'" v-model="password" type="password" placeholder="Password (6+ characters)" required minlength="6"
        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'">
      <button class="btn primary wide" :disabled="busy">{{ mode === 'login' ? 'Log in' : mode === 'register' ? 'Create account' : 'Send reset link' }}</button>
      <button v-if="mode === 'login'" type="button" class="link" @click="mode = 'forgot'">Forgot password?</button>
      <button v-if="mode === 'forgot'" type="button" class="link" @click="mode = 'login'">← Back to log in</button>
      <p v-if="err" class="error">{{ err }}</p>
      <p v-if="msg" class="ok">{{ msg }}</p>
    </form>
  </div>`,
};

const RecoveryForm = {
  emits: ['done'],
  setup(_, { emit }) {
    const pw = ref(''), err = ref('');
    const save = async () => {
      const { error } = await sb.auth.updateUser({ password: pw.value });
      if (error) err.value = error.message; else emit('done');
    };
    return { pw, err, save };
  },
  template: `
  <div class="auth"><form class="card stack" @submit.prevent="save">
    <h3>Choose a new password</h3>
    <input v-model="pw" type="password" minlength="6" required placeholder="New password" autocomplete="new-password">
    <button class="btn primary wide">Save password</button>
    <p v-if="err" class="error">{{ err }}</p>
  </form></div>`,
};

const RoomSetup = {
  props: ['me'],
  emits: ['reload', 'signout'],
  setup(props, { emit }) {
    const name = ref('Our page'), tz = ref('Asia/Almaty'), link = ref(''), err = ref(''), copied = ref(false);
    const inviteUrl = computed(() => props.me.room?.invite_token ? location.origin + '/#/invite/' + props.me.room.invite_token : '');
    const run = async (fn) => { err.value = ''; try { await fn(); emit('reload'); } catch (e) { err.value = e.message; } };
    const create = () => run(() => api('/rooms', { method: 'POST', body: { name: name.value, timezone: tz.value } }));
    const join = () => run(() => {
      const token = link.value.trim().split('/invite/').pop();
      return api('/invites/' + encodeURIComponent(token) + '/join', { method: 'POST' });
    });
    const newInvite = () => run(() => api('/rooms/invite', { method: 'POST' }));
    const copy = async () => { try { await navigator.clipboard.writeText(inviteUrl.value); copied.value = true; } catch { /* select manually */ } };
    return { name, tz, link, err, copied, inviteUrl, create, join, newInvite, copy, TIMEZONES };
  },
  template: `
  <div class="auth stack">
    <div class="logo big-logo">SAME PAGE</div>
    <template v-if="me.room">
      <div class="card stack center">
        <div class="big">⏳</div>
        <h3>Waiting for your friend</h3>
        <p class="muted">Send them this private link. It works once and expires in 7 days.</p>
        <template v-if="inviteUrl">
          <input :value="inviteUrl" readonly @focus="$event.target.select()">
          <button class="btn primary wide" @click="copy">{{ copied ? 'Copied ✓' : 'Copy invite link' }}</button>
        </template>
        <button v-else class="btn primary wide" @click="newInvite">Create a new invite link</button>
        <button class="link" @click="$emit('reload')">I sent it — refresh</button>
      </div>
    </template>
    <template v-else>
      <p class="center">Hi <b>{{ me.user.display_name }}</b>! Start a page for two, or join your friend’s.</p>
      <div class="card stack">
        <h3>Create a room</h3>
        <input v-model="name" maxlength="60" placeholder="Room name">
        <label class="muted small">The daily question changes at midnight in:</label>
        <select v-model="tz"><option v-for="t in TIMEZONES" :key="t">{{ t }}</option></select>
        <button class="btn primary wide" @click="create">Create & get invite link</button>
      </div>
      <div class="card stack">
        <h3>Have an invite?</h3>
        <input v-model="link" placeholder="Paste the invite link">
        <button class="btn wide" :disabled="!link.trim()" @click="join">Join room</button>
      </div>
    </template>
    <p v-if="err" class="error">{{ err }}</p>
    <button class="link" @click="$emit('signout')">Sign out</button>
  </div>`,
};

/* ------------------------------------------------------------ root */

const App = {
  components: { AuthScreen, RecoveryForm, RoomSetup, DailyPage, ArchivePage, PlayPage, ProfilePage },
  setup() {
    const ready = ref(false), fatal = ref(''), session = ref(null), me = ref(null), recovery = ref(false);
    const tab = ref('daily'), toast = ref('');
    const m = location.hash.match(/^#\/invite\/([\w-]+)/);
    let inviteToken = m ? m[1] : null;

    async function loadMe() {
      try {
        me.value = await api('/me');
        if (inviteToken && !me.value.room) {
          const token = inviteToken; inviteToken = null;
          me.value = await api('/invites/' + token + '/join', { method: 'POST' });
          toast.value = 'You joined the room 🎉';
        }
      } catch (e) { toast.value = e.message; }
      if (location.hash.startsWith('#/invite/') && !inviteToken) history.replaceState(null, '', location.pathname);
    }
    async function signOut() { await sb.auth.signOut(); me.value = null; tab.value = 'daily'; }

    watch(session, (s, old) => { if (s && !old) loadMe(); if (!s) me.value = null; });

    onMounted(async () => {
      try {
        const cfg = await fetch('/api/config').then((r) => r.json());
        sb = supabase.createClient(cfg.supabase_url, cfg.supabase_anon_key);
        sb.auth.onAuthStateChange((event, s) => {
          session.value = s;
          if (event === 'PASSWORD_RECOVERY') recovery.value = true;
        });
        session.value = (await sb.auth.getSession()).data.session;
      } catch (e) { fatal.value = 'Could not start: ' + e.message; }
      ready.value = true;
    });

    const tabs = [
      { id: 'daily', label: 'Daily', icon: '☀️' },
      { id: 'archive', label: 'Archive', icon: '📖' },
      { id: 'play', label: 'Play', icon: '🎲' },
      { id: 'profile', label: 'Profile', icon: '🙂' },
    ];
    const go = (id) => { tab.value = id; window.scrollTo(0, 0); };
    return { ready, fatal, session, me, recovery, tab, tabs, toast, loadMe, signOut, go };
  },
  template: `
  <div v-if="!ready" class="splash logo">SAME PAGE</div>
  <div v-else-if="fatal" class="splash"><p class="error">{{ fatal }}</p></div>
  <recovery-form v-else-if="recovery" @done="recovery = false" />
  <auth-screen v-else-if="!session" />
  <div v-else-if="!me" class="splash logo">SAME PAGE</div>
  <room-setup v-else-if="!me.room || me.room.status !== 'active'" :me="me" @reload="loadMe" @signout="signOut" />
  <div v-else class="shell">
    <header class="topbar">
      <div class="logo">SAME PAGE</div>
      <nav class="nav">
        <button v-for="t in tabs" :key="t.id" :class="{ on: tab === t.id }" @click="go(t.id)">
          <span class="nav-icon">{{ t.icon }}</span><span>{{ t.label }}</span>
        </button>
      </nav>
    </header>
    <main class="page">
      <daily-page v-if="tab === 'daily'" :name="me.user.display_name" />
      <archive-page v-else-if="tab === 'archive'" />
      <play-page v-else-if="tab === 'play'" />
      <profile-page v-else :me="me" @reload="loadMe" @signout="signOut" />
    </main>
  </div>
  <div v-if="toast" class="toast" @click="toast = ''">{{ toast }}</div>`,
};

createApp(App).mount('#app');
