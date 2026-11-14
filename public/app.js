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
  view: 'chat', // 'chat' | 'terminal'
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
let mdHooked = false;
function renderMd(text) {
  if (window.marked && window.DOMPurify) {
    if (!mdHooked) {
      // Links (inclusive arquivos em /api/files/raw) abrem em nova aba para não sair do chat.
      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.getAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      });
      mdHooked = true;
    }
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
    if (c.id === state.currentId && state.view === 'chat') row.classList.add('active');
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
  const known = state.conversations.find((c) => c.id === id);
  if (known) $('#conv-title').textContent = known.title;
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
  closeNav();
  // Veio de /escritorio sem login: depois de entrar, segue para o escritório.
  if (location.hash === '#/escritorio') {
    history.replaceState(null, '', '/');
    location.assign('/escritorio');
    return;
  }
  if (location.hash === '#/terminal') return showTerminal();
  if (location.hash === '#/agentes') return showAgents();
  if (state.view !== 'chat') {
    setView('chat');
    $('#conv-title').textContent = 'Nova tarefa';
  }
  const m = location.hash.match(/^#\/c\/([a-z0-9-]+)$/);
  openConversation(m ? m[1] : null);
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

// ---------------------------------------------------------------- Terminal
// Shell no servidor via WebSocket. A sessão continua viva se a conexão cair:
// ao reconectar, o servidor reenvia a tela recente.
const XTERM_CDN = 'https://cdn.jsdelivr.net/npm/@xterm';
const TERM_THEME = {
  background: '#0F2A33',
  foreground: '#DCE8EC',
  cursor: '#D99A1E',
  cursorAccent: '#0F2A33',
  selectionBackground: 'rgba(217, 154, 30, 0.35)',
  black: '#0A1F26', red: '#E0667A', green: '#5FBF8F', yellow: '#E6AE3E',
  blue: '#7AA7F2', magenta: '#C38FE0', cyan: '#4FB3C4', white: '#CFE0E5',
  brightBlack: '#5B7882', brightRed: '#F08A9B', brightGreen: '#86D9AE', brightYellow: '#F3C86A',
  brightBlue: '#A3C3F7', brightMagenta: '#D9B3EF', brightCyan: '#7FD3E0', brightWhite: '#FFFFFF',
};
const term = { xterm: null, fit: null, ws: null, sessionId: null, ended: false, killing: false, retry: 0, retryTimer: 0, ctrl: false };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não consegui carregar o terminal (falha ao baixar o xterm.js). Verifique a conexão e recarregue.'));
    document.head.append(s);
  });
}

let xtermLoading = null;
function loadXterm() {
  if (!xtermLoading) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${XTERM_CDN}/xterm@6.0.0/css/xterm.css`;
    document.head.append(css);
    xtermLoading = loadScript(`${XTERM_CDN}/xterm@6.0.0/lib/xterm.js`).then(() =>
      Promise.all([
        loadScript(`${XTERM_CDN}/addon-fit@0.11.0/lib/addon-fit.js`),
        loadScript(`${XTERM_CDN}/addon-web-links@0.12.0/lib/addon-web-links.js`),
      ]),
    );
    xtermLoading.catch(() => (xtermLoading = null));
  }
  return xtermLoading;
}

function termSend(payload) {
  if (term.ws?.readyState === WebSocket.OPEN) term.ws.send(payload);
}
function termResizeMsg() {
  termSend('1' + JSON.stringify({ type: 'resize', cols: term.xterm.cols, rows: term.xterm.rows }));
}
function fitTerm() {
  if (!term.xterm || $('#term-view').hidden) return;
  try {
    term.fit.fit();
  } catch {
    /* elemento ainda sem tamanho */
  }
}
function setTermStatus(text, tone) {
  const s = $('#term-status');
  s.textContent = text;
  s.className = `term-status${tone ? ` ${tone}` : ''}`;
  $('#term-kill').disabled = tone !== 'ok';
}
function setCtrl(on) {
  term.ctrl = on;
  $('#term-keys [data-key="ctrl"]').setAttribute('aria-pressed', String(on));
}

// Uma única criação, mesmo que a tela do terminal seja aberta duas vezes seguidas
// (ex.: clique em "Terminal" enquanto a lista de conversas ainda carrega após o login).
let termInit = null;
function ensureTerminal() {
  if (!termInit) termInit = createTerminal().catch((err) => {
    termInit = null;
    throw err;
  });
  return termInit;
}

async function createTerminal() {
  await loadXterm();
  try {
    await document.fonts.load('14px "JetBrains Mono"');
  } catch {
    /* segue com a fonte reserva */
  }
  const x = new window.Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
    fontSize: coarse ? 13 : 14,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: TERM_THEME,
  });
  term.fit = new window.FitAddon.FitAddon();
  x.loadAddon(term.fit);
  x.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  x.open($('#term'));

  // Ctrl+C com texto selecionado copia; sem seleção, interrompe o comando. Ctrl+V cola.
  x.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (mod && key === 'c' && (ev.shiftKey || x.hasSelection())) {
      if (x.hasSelection()) navigator.clipboard?.writeText(x.getSelection()).catch(() => undefined);
      return false;
    }
    if (mod && key === 'v') return false; // o navegador dispara o "colar" e o xterm envia o texto
    return true;
  });

  x.onData((data) => {
    if (term.ctrl && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
      setCtrl(false);
    }
    termSend('0' + data);
  });
  x.onResize(termResizeMsg);
  new ResizeObserver(fitTerm).observe($('#term'));
  term.xterm = x;
}

function termConnect(fresh) {
  clearTimeout(term.retryTimer);
  const x = term.xterm;
  const qs = new URLSearchParams({ cols: String(x.cols), rows: String(x.rows) });
  if (fresh) qs.set('new', '1');
  else if (term.sessionId) qs.set('session', term.sessionId);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal?${qs}`);
  term.ws = ws;
  term.ended = false;
  term.killing = false;
  $('#term-ended').hidden = true;
  setTermStatus(term.retry ? 'Reconectando…' : 'Conectando…', 'warn');

  ws.onopen = () => {
    term.retry = 0;
    setTermStatus('Conectado', 'ok');
    fitTerm();
    termResizeMsg();
  };
  ws.onmessage = (ev) => {
    const kind = ev.data[0];
    const body = ev.data.slice(1);
    if (kind === '0') return x.write(body);
    let c;
    try {
      c = JSON.parse(body);
    } catch {
      return;
    }
    if (c.type === 'session') {
      const lost = term.sessionId && term.sessionId !== c.id;
      term.sessionId = c.id;
      x.reset(); // o servidor reenvia a tela recente logo em seguida
      if (lost) x.write('\x1b[2m[A sessão anterior terminou (o servidor pode ter reiniciado). Este é um terminal novo.]\x1b[0m\r\n');
    } else if (c.type === 'exit') {
      showTermEnded(c.code && !c.signal && !term.killing ? `O shell saiu com código ${c.code}.` : 'Sessão encerrada.');
    } else if (c.type === 'error') {
      showTermEnded(c.message);
    }
  };
  ws.onclose = () => {
    if (term.ws !== ws) return;
    term.ws = null;
    if (term.ended) return;
    term.retry++;
    setTermStatus('Reconectando…', 'warn');
    const delay = Math.min(1000 * 2 ** (term.retry - 1), 15000);
    term.retryTimer = setTimeout(async () => {
      try {
        const me = await api('/me');
        if (me.terminal === false) return showTermEnded('O terminal está desligado neste servidor (variável TERMINAL=off).');
      } catch {
        if ($('#app').hidden) return; // sessão expirou: a tela de login já apareceu
      }
      if (state.view === 'terminal') termConnect(false);
    }, delay);
  };
}

function termDisconnect() {
  clearTimeout(term.retryTimer);
  const ws = term.ws;
  term.ws = null;
  ws?.close();
}

function showTermEnded(message) {
  term.ended = true;
  termDisconnect();
  $('#term-ended-msg').textContent = message;
  $('#term-ended').hidden = false;
  setTermStatus('Encerrado');
}

function setView(view) {
  state.view = view;
  const isTerm = view === 'terminal';
  const isAgents = view === 'agentes';
  const isChat = view === 'chat';
  $('#scroller').hidden = !isChat;
  $('#composer').hidden = !isChat;
  $('#model-pick').hidden = !isChat;
  $('#term-view').hidden = !isTerm;
  $('#term-actions').hidden = !isTerm;
  $('#term-keys').hidden = !(isTerm && coarse);
  $('#agents-view').hidden = !isAgents;
  $('#open-term').classList.toggle('active', isTerm);
  $('#open-agents').classList.toggle('active', isAgents);
  if (isTerm) $('#conv-title').textContent = 'Terminal';
  if (isAgents) $('#conv-title').textContent = 'Agentes';
  if (!isAgents) closeAgentsStream();
  renderConvList();
}

// ---------------------------------------------------------------- Agentes
let agentsStream = null;
let agentsTick = null;
let agentsData = null;

function closeAgentsStream() {
  agentsStream?.close();
  agentsStream = null;
  clearInterval(agentsTick);
  agentsTick = null;
}

function showAgents() {
  setView('agentes');
  if (agentsStream) return;
  agentsStream = new EventSource('/api/agentes/eventos');
  agentsStream.onmessage = (e) => {
    try {
      agentsData = JSON.parse(e.data);
      renderAgents();
    } catch {
      /* evento torto: espera o próximo */
    }
  };
  agentsStream.onerror = async () => {
    // A sessão pode ter caído: /me devolve 401 e mostra o login.
    if (agentsStream?.readyState === EventSource.CLOSED) {
      closeAgentsStream();
      try {
        await api('/me');
        if (state.view === 'agentes') setTimeout(showAgents, 3000);
      } catch {
        /* login já na tela */
      }
    }
  };
  // Os cronômetros de quem está trabalhando andam a cada segundo.
  agentsTick = setInterval(() => agentsData && renderAgentsTimers(), 1000);
}

const MODELO_CURTO = (m) => (/haiku/i.test(m) ? 'Haiku' : /sonnet/i.test(m) ? 'Sonnet' : /opus/i.test(m) ? 'Opus' : /fable/i.test(m) ? 'Fable' : m);

function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} mi` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n);
}

function renderAgents() {
  const d = agentsData;
  if (!d || state.view !== 'agentes') return;

  // Assinatura
  const a = d.assinatura;
  const meter = $('#agents-meter');
  if (a && a.utilizacao !== null) {
    const pct = Math.round(a.utilizacao * 100);
    const janela = a.tipo === 'five_hour' ? 'da janela de 5 h' : a.tipo === 'seven_day' ? 'da semana' : 'da janela';
    $('#agents-usage').textContent = `${pct}% ${janela}`;
    meter.style.width = `${Math.min(100, pct)}%`;
    meter.className = a.utilizacao >= a.tetoAutomatico ? 'warn' : '';
    const renova = a.renovaEm
      ? ` Renova ${new Date(a.renovaEm).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`
      : '';
    $('#agents-usage-note').textContent =
      a.utilizacao >= a.tetoAutomatico
        ? `Acima de ${Math.round(a.tetoAutomatico * 100)}%: os pedidos automáticos voltam para a API do sistema que chamou.${renova}`
        : `Pedidos automáticos param em ${Math.round(a.tetoAutomatico * 100)}%; os de tela, em ${Math.round(a.tetoTela * 100)}%.${renova}`;
  } else {
    $('#agents-usage').textContent = 'sem leitura ainda';
    meter.style.width = '0';
    $('#agents-usage-note').textContent = 'O uso aparece depois do primeiro pedido.';
  }

  // Escritório
  const office = d.escritorio || {};
  const link = $('#agents-office-link');
  link.hidden = !(office.ligado && office.url);
  if (office.url) link.href = office.url;
  $('#agents-office-off').hidden = !!(office.ligado && office.url);
  $('#agents-office-off').textContent = office.ligado ? 'Escritório sem endereço público (ESCRITORIO_HOSTS).' : 'Escritório desligado.';
  $('#open-office').hidden = !(office.ligado && office.url);

  // Salas
  const rooms = $('#agents-rooms');
  rooms.replaceChildren();
  for (const ag of d.agentes) {
    const room = el('article', 'room');
    if (ag.rodando.length) room.classList.add('busy');
    const head = el('header', 'room-head');
    head.append(el('h4', null, ag.nome), el('span', 'room-model', `${MODELO_CURTO(ag.modelo)} · esforço ${ag.esforco}`));
    room.append(head, el('p', 'room-desc', ag.descricao));

    const seats = el('div', 'room-seats');
    seats.setAttribute('aria-label', `${ag.rodando.length} de ${ag.simultaneos} vagas ocupadas, ${ag.naFila} na fila`);
    for (let i = 0; i < ag.simultaneos; i++) seats.append(el('span', i < ag.rodando.length ? 'seat on' : 'seat'));
    if (ag.naFila) seats.append(el('span', 'room-queue', `+${ag.naFila} na fila`));
    room.append(seats);

    const now = el('ul', 'room-now');
    if (!ag.rodando.length) now.append(el('li', 'room-idle', 'Livre'));
    for (const r of ag.rodando) {
      const li = el('li');
      li.append(el('span', 'room-task', [r.assunto, r.empresa].filter(Boolean).join(' · ')));
      const t = el('time', 'room-timer');
      t.dataset.since = r.desde;
      li.append(t);
      now.append(li);
    }
    room.append(now);

    const h = ag.hoje;
    const stats = el('dl', 'room-stats');
    const stat = (k, v) => stats.append(el('dt', null, k), el('dd', null, v));
    stat('Hoje', String(h.ok));
    stat('Média', fmtDur(h.mediaMs));
    stat('Erros', String(h.erro));
    stat('Recusados', String(h.recusado));
    room.append(stats);
    rooms.append(room);
  }
  renderAgentsTimers();

  // Atividade
  const feed = $('#agents-feed');
  feed.replaceChildren();
  if (!d.ultimos.length) feed.append(el('li', 'feed-empty', 'Nenhum pedido ainda hoje.'));
  const nomes = Object.fromEntries(d.agentes.map((x) => [x.id, x.nome]));
  for (const u of d.ultimos.slice(0, 40)) {
    const li = el('li', `feed-${u.status}`);
    const t = el('time', null, new Date(u.em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const what = el('span', 'feed-what', [u.assunto, u.empresa].filter(Boolean).join(' · '));
    const who = el('span', 'feed-who', `${nomes[u.agente] || u.agente}${u.origem === 'tela' ? ' · na tela' : ''}`);
    const res =
      u.status === 'ok'
        ? el('span', 'feed-res', `${fmtDur(u.duracaoMs)} · ${fmtTokens(u.tokensEntrada + u.tokensSaida)} tokens`)
        : el('span', 'feed-res', `${u.status === 'erro' ? 'Erro' : 'Recusado'}: ${u.motivo || ''}`);
    li.append(t, what, who, res);
    feed.append(li);
  }
}

function renderAgentsTimers() {
  for (const t of document.querySelectorAll('#agents-rooms .room-timer')) {
    t.textContent = fmtDur(Date.now() - new Date(t.dataset.since).getTime());
  }
}

async function showTerminal() {
  setView('terminal');
  try {
    await ensureTerminal();
  } catch (err) {
    showTermEnded(err.message);
    return;
  }
  if (state.view !== 'terminal') return;
  fitTerm();
  if (!term.ws && !term.ended) {
    clearTimeout(term.retryTimer);
    termConnect(false);
  }
  term.xterm.focus();
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
  termDisconnect();
  closeAgentsStream();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#password').focus();
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await refreshList();
  route();
  if (state.view === 'chat') $('#input').focus();
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
$('#open-term').addEventListener('click', closeNav);
$('#term-kill').addEventListener('click', () => {
  if (!confirm('Encerrar o terminal? Os comandos que estiverem rodando nele serão finalizados.')) return;
  term.killing = true;
  termSend('1' + JSON.stringify({ type: 'kill' }));
});
$('#term-new').addEventListener('click', () => {
  $('#term-ended').hidden = true;
  term.sessionId = null;
  term.retry = 0;
  term.xterm?.reset();
  if (term.xterm) termConnect(true);
  else showTerminal();
  term.xterm?.focus();
});
const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };
for (const b of document.querySelectorAll('#term-keys button')) {
  // Não tira o foco do terminal (o teclado do celular continua aberto).
  b.addEventListener('pointerdown', (ev) => ev.preventDefault());
  b.addEventListener('mousedown', (ev) => ev.preventDefault());
  b.addEventListener('click', () => {
    const k = b.dataset.key;
    if (k === 'ctrl') return setCtrl(!term.ctrl);
    let seq = '';
    if (k === 'esc') seq = '\x1b';
    else if (k === 'tab') seq = '\t';
    else if (k === 'ctrlc') seq = '\x03';
    else if (ARROWS[k]) seq = (term.xterm?.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROWS[k];
    termSend('0' + seq);
    term.xterm?.focus();
  });
}
$('#menu').addEventListener('click', openNav);
$('#scrim').addEventListener('click', closeNav);
window.addEventListener('hashchange', route);

boot();
