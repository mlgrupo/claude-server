'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  conversations: [],
  currentId: null,
  run: null, // execução que o botão Parar controla
  streams: new Set(), // EventSources abertos
  running: new Set(),
};

const BRAIN_ICON =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.2"/><circle cx="3.5" cy="5" r="1.6"/><circle cx="16.5" cy="5" r="1.6"/><circle cx="4" cy="16" r="1.6"/><circle cx="16" cy="15.5" r="1.6"/><path d="M5 6l3 2.4M15 6l-3 2.4M5.3 15l2.6-2.6M14.8 14.6l-2.6-2.3"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>';

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Sessão expirada — entre de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- Markdown
function renderMd(text) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  }
  const d = el('div');
  d.textContent = text;
  return d.innerHTML.replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------- Formatação
function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtWhen(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}
function metaLine(meta) {
  if (!meta) return null;
  const line = el('div', 'meta');
  const parts = [];
  if (meta.status === 'error') parts.push('<span class="bad">Terminou com erro</span>');
  else if (meta.status === 'aborted') parts.push('<span class="bad">Interrompida</span>');
  else parts.push('Concluída');
  if (meta.numTurns) parts.push(`${meta.numTurns} ${meta.numTurns === 1 ? 'passo' : 'passos'}`);
  if (meta.durationMs) parts.push(fmtDuration(meta.durationMs));
  line.innerHTML = parts.join(', ');
  return line;
}
function learnedBlock(status, summary) {
  const b = el('div', 'learned');
  if (status === 'started') {
    b.classList.add('pending');
    b.innerHTML = `${BRAIN_ICON}<strong>Registrando aprendizado</strong><span>O agente está revisando a tarefa e atualizando o cérebro.</span>`;
  } else if (status === 'error') {
    b.classList.add('failed');
    b.innerHTML = `${BRAIN_ICON}<strong>Não consegui registrar o aprendizado</strong><span></span>`;
    b.lastElementChild.textContent = summary || '';
  } else {
    b.innerHTML = `${BRAIN_ICON}<strong>Aprendizado registrado</strong><span></span>`;
    b.lastElementChild.textContent = summary || '';
  }
  return b;
}

// ---------------------------------------------------------------- Ferramentas
function toolEl(seg, running) {
  const d = el('details', 'tool');
  d.dataset.id = seg.id;
  if (running) d.classList.add('running');
  if (seg.isError) d.classList.add('error');
  const s = el('summary');
  s.append(el('span', 'dot'), el('span', 'tname', seg.name), el('span', 'tsum', seg.summary || ''));
  const pre = el('pre', null, seg.result ?? (running ? 'Executando…' : 'Sem saída.'));
  d.append(s, pre);
  return d;
}
function finishTool(d, isError, preview) {
  d.classList.remove('running');
  d.classList.toggle('error', !!isError);
  $('pre', d).textContent = preview || 'Sem saída.';
}

// ---------------------------------------------------------------- Thread
const scroller = () => $('#scroller');
function nearBottom() {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < 160;
}
function toBottom(force) {
  if (force || nearBottom()) scroller().scrollTop = scroller().scrollHeight;
}

function userEl(text) {
  return el('div', 'msg-user', text);
}

function agentEl(msg) {
  const box = el('div', 'msg-agent');
  for (const seg of msg.segments || []) {
    if (seg.type === 'text') {
      const t = el('div', 'md');
      t.innerHTML = renderMd(seg.text);
      box.append(t);
    } else if (seg.type === 'tool') box.append(toolEl(seg, false));
  }
  const m = metaLine(msg.meta);
  if (m) box.append(m);
  if (msg.meta?.brain) box.append(learnedBlock('done', msg.meta.brain));
  return box;
}

function renderConversation(conv) {
  const thread = $('#thread');
  thread.replaceChildren();
  for (const m of conv.messages) thread.append(m.role === 'user' ? userEl(m.text) : agentEl(m));
  $('#empty').hidden = conv.messages.length > 0;
  $('#conv-title').textContent = conv.title;
  toBottom(true);
}

function resetThread() {
  $('#thread').replaceChildren();
  $('#empty').hidden = false;
  $('#conv-title').textContent = 'Nova tarefa';
}

// ---------------------------------------------------------------- Execução ao vivo
function setBusy(busy, label) {
  $('#send').disabled = busy;
  $('#stop').hidden = !busy;
  $('#status').textContent = label || '';
}

function closeStream() {
  for (const es of state.streams) es.close();
  state.streams.clear();
  state.run = null;
}

function followRun(runId, conversationId) {
  const box = el('div', 'msg-agent');
  const typing = el('div', 'typing');
  typing.innerHTML = '<i></i><i></i><i></i>';
  box.append(typing);
  $('#thread').append(box);
  toBottom(true);

  const live = { box, typing, textEl: null, buffer: '', tools: new Map(), raf: 0, brainEl: null, gotResult: false };
  const es = new EventSource(`/api/runs/${runId}/events`);
  state.streams.add(es);
  state.run = { id: runId, es, live, conversationId };
  state.running.add(conversationId);
  renderConvList();
  setBusy(true, 'Trabalhando…');

  const place = (node) => {
    box.insertBefore(node, live.typing.isConnected ? live.typing : null);
    toBottom();
  };
  const flush = () => {
    live.raf = 0;
    if (live.textEl) live.textEl.innerHTML = renderMd(live.buffer);
    toBottom();
  };
  const newText = () => {
    live.textEl = el('div', 'md');
    live.buffer = '';
    place(live.textEl);
  };

  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    switch (e.type) {
      case 'text_start':
        newText();
        break;
      case 'text_delta':
        if (!live.textEl) newText();
        live.buffer += e.text;
        if (!live.raf) live.raf = requestAnimationFrame(flush);
        break;
      case 'tool_use': {
        live.textEl = null;
        const d = toolEl({ id: e.id, name: e.name, summary: e.summary }, true);
        live.tools.set(e.id, d);
        place(d);
        break;
      }
      case 'tool_result': {
        const d = live.tools.get(e.id);
        if (d) finishTool(d, e.isError, e.preview);
        break;
      }
      case 'notice':
        place(el('div', 'notice', e.message));
        break;
      case 'result': {
        live.gotResult = true;
        if (live.raf) {
          cancelAnimationFrame(live.raf);
          flush();
        }
        live.typing.remove();
        if (e.status !== 'success' && e.text) {
          const w = el('div', 'md warn');
          w.textContent = `⚠️ ${e.text}`;
          box.append(w);
        }
        const m = metaLine({ status: e.status, numTurns: e.numTurns, durationMs: e.durationMs });
        if (m) box.append(m);
        state.running.delete(conversationId);
        renderConvList();
        setBusy(false, '');
        toBottom();
        break;
      }
      case 'brain':
        if (live.brainEl) live.brainEl.remove();
        live.brainEl = learnedBlock(e.status, e.summary);
        box.append(live.brainEl);
        if (e.status === 'started' && state.currentId === conversationId) $('#status').textContent = 'Registrando aprendizado…';
        else if (state.currentId === conversationId) $('#status').textContent = '';
        toBottom();
        break;
      case 'done':
        es.close();
        state.streams.delete(es);
        live.typing.remove();
        state.running.delete(conversationId);
        if (state.run?.id === runId) state.run = null;
        if (state.currentId === conversationId) setBusy(false, '');
        refreshList();
        break;
    }
  };
  es.onerror = () => {
    // O EventSource reconecta sozinho e retoma do último evento (Last-Event-ID).
    if (es.readyState === EventSource.CLOSED && !live.gotResult) setBusy(false, 'Conexão perdida — recarregue a conversa.');
  };
}

// ---------------------------------------------------------------- Conversas
function renderConvList() {
  const list = $('#conv-list');
  list.replaceChildren();
  if (!state.conversations.length) {
    list.append(el('p', 'conv-empty', 'Nenhuma conversa ainda.'));
    return;
  }
  for (const c of state.conversations) {
    const row = el('div', 'conv-item');
    if (c.id === state.currentId) row.classList.add('active');
    const a = el('a');
    a.href = `#/c/${c.id}`;
    a.append(el('span', null, c.title), el('small', null, fmtWhen(c.updatedAt)));
    row.append(a);
    if (state.running.has(c.id)) row.append(el('span', 'running-dot'));
    const del = el('button', 'conv-del');
    del.type = 'button';
    del.title = 'Apagar conversa';
    del.setAttribute('aria-label', `Apagar "${c.title}"`);
    del.innerHTML = TRASH_ICON;
    del.onclick = async () => {
      if (!confirm(`Apagar a conversa "${c.title}"? O que o cérebro aprendeu com ela continua salvo.`)) return;
      try {
        await api(`/conversations/${c.id}`, { method: 'DELETE' });
        if (state.currentId === c.id) location.hash = '';
        await refreshList();
      } catch (err) {
        alert(err.message);
      }
    };
    row.append(del);
    list.append(row);
  }
}

async function refreshList() {
  try {
    state.conversations = await api('/conversations');
    renderConvList();
  } catch {
    /* ignorado */
  }
}

async function openConversation(id) {
  closeStream();
  state.currentId = id;
  renderConvList();
  setBusy(false, '');
  if (!id) return resetThread();
  try {
    const conv = await api(`/conversations/${id}`);
    if (state.currentId !== id) return;
    renderConversation(conv);
    if (conv.activeRunId) followRun(conv.activeRunId, id);
  } catch (err) {
    resetThread();
    $('#status').textContent = err.message;
  }
}

function route() {
  const m = location.hash.match(/^#\/c\/([a-z0-9-]+)$/);
  openConversation(m ? m[1] : null);
  closeNav();
}

// ---------------------------------------------------------------- Envio
async function send(text) {
  const message = text.trim();
  if (!message || $('#send').disabled) return;
  const input = $('#input');
  input.value = '';
  autosize();
  $('#empty').hidden = true;
  $('#thread').append(userEl(message));
  toBottom(true);
  setBusy(true, 'Iniciando…');
  try {
    const body = { message };
    if (state.currentId) body.conversationId = state.currentId;
    const model = $('#model').value;
    if (model) body.model = model;
    const r = await api('/chat', { method: 'POST', body: JSON.stringify(body) });
    if (!state.currentId) {
      state.currentId = r.conversationId;
      history.replaceState(null, '', `#/c/${r.conversationId}`);
      $('#conv-title').textContent = message.slice(0, 70);
    }
    followRun(r.runId, r.conversationId);
    refreshList();
  } catch (err) {
    setBusy(false, err.message);
    input.value = message;
    autosize();
  }
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

// ---------------------------------------------------------------- Cérebro
function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: '', body: text };
}

async function openBrainFile(path, btn) {
  for (const b of document.querySelectorAll('.brain-files button')) b.classList.toggle('active', b === btn);
  const view = $('#brain-view');
  try {
    const { content } = await api(`/brain/file?path=${encodeURIComponent(path)}`);
    const { front, body } = splitFrontmatter(content);
    view.replaceChildren();
    if (front) view.append(el('div', 'front', front));
    const md = el('div');
    md.innerHTML = renderMd(body);
    view.append(md);
    view.scrollTop = 0;
  } catch (err) {
    view.textContent = err.message;
  }
}

async function openBrain() {
  const dlg = $('#brain');
  dlg.showModal();
  try {
    const data = await api('/brain');
    $('#brain-dir').textContent = data.dir;
    const files = $('#brain-files');
    files.replaceChildren();
    for (const f of data.files) {
      const li = el('li');
      const b = el('button', null, f.path);
      b.type = 'button';
      b.onclick = () => openBrainFile(f.path, b);
      li.append(b);
      files.append(li);
    }
    const hist = $('#brain-history');
    hist.replaceChildren();
    if (!data.history.length) hist.append(el('li', 'muted', 'Nenhum aprendizado registrado ainda.'));
    for (const h of data.history) {
      const li = el('li');
      const t = el('time', null, new Date(h.date).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }));
      t.dateTime = h.date;
      li.append(t, document.createTextNode(h.message.replace(/^aprendizado:\s*/, '')));
      hist.append(li);
    }
    const index = [...files.querySelectorAll('button')].find((b) => b.textContent === 'INDEX.md');
    if (index) openBrainFile('INDEX.md', index);
  } catch (err) {
    $('#brain-view').textContent = err.message;
  }
}

// ---------------------------------------------------------------- Navegação mobile
function openNav() {
  $('#app').classList.add('nav-open');
  $('#scrim').hidden = false;
}
function closeNav() {
  $('#app').classList.remove('nav-open');
  $('#scrim').hidden = true;
}

// ---------------------------------------------------------------- Login / boot
function showLogin() {
  closeStream();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#password').focus();
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await refreshList();
  route();
  $('#input').focus();
}

async function boot() {
  try {
    model.value = localStorage.getItem('hb-model') || '';
  } catch {
    /* sem storage */
  }
  try {
    const me = await api('/me');
    if (!me.credentials) console.warn('Servidor sem credenciais do Claude configuradas.');
    await showApp();
  } catch {
    showLogin();
  }
}

const model = $('#model');
model.addEventListener('change', () => {
  try {
    localStorage.setItem('hb-model', model.value);
  } catch {
    /* sem storage */
  }
});

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
  showLogin();
});

$('#composer').addEventListener('submit', (ev) => {
  ev.preventDefault();
  send($('#input').value);
});

const coarse = window.matchMedia('(pointer: coarse)').matches;
$('#input').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing) return;
  if (ev.ctrlKey || ev.metaKey || (!ev.shiftKey && !coarse)) {
    ev.preventDefault();
    send($('#input').value);
  }
});
$('#input').addEventListener('input', autosize);

$('#stop').addEventListener('click', async () => {
  if (!state.run) return;
  $('#status').textContent = 'Parando…';
  await api(`/runs/${state.run.id}/stop`, { method: 'POST', body: '{}' }).catch((err) => ($('#status').textContent = err.message));
});

$('#new-chat').addEventListener('click', () => {
  location.hash = '';
  closeNav();
  $('#input').focus();
});

for (const b of document.querySelectorAll('.examples button')) {
  b.addEventListener('click', () => {
    $('#input').value = b.textContent;
    autosize();
    $('#input').focus();
  });
}

$('#open-brain').addEventListener('click', () => {
  closeNav();
  openBrain();
});
$('#close-brain').addEventListener('click', () => $('#brain').close());
$('#brain').addEventListener('click', (ev) => {
  if (ev.target === ev.currentTarget) ev.currentTarget.close();
});
$('#menu').addEventListener('click', openNav);
$('#scrim').addEventListener('click', closeNav);
window.addEventListener('hashchange', route);

boot();
