'use strict';

const fs = require('fs');
const path = require('path');
const {
  PluginPanel, RoutingGroups, magpieConfigDir, getCustomProvider,
} = require('./magpie-adapter');

const SELF_HOSTED = ['workbuddy', 'codearts', 'loomy', 'lingxi'];
const PROVIDER_IDS = new Set(SELF_HOSTED.map((id) => `wanneng-${id}`));
const ALIAS_LIMIT = 200;
const MODEL_LIMIT = 500;

const lower = (value) => String(value || '').toLowerCase();
const unique = (values) => {
  const seen = new Map();
  for (const value of values) {
    const key = lower(value);
    if (key && !seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
};
const sameSet = (a, b) => {
  const aa = unique(a).map(lower).sort();
  const bb = unique(b).map(lower).sort();
  return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
};
const sameAliases = (a, b) => {
  const normalize = (value) => new Map(Object.entries(value || {}).map(([name, target]) => [lower(name), lower(target)]));
  const aa = normalize(a);
  const bb = normalize(b);
  return aa.size === bb.size && [...aa].every(([name, target]) => bb.get(name) === target);
};
const aliasOf = (modelId) => {
  const id = String(modelId || '');
  return id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
};
const refParts = (ref) => {
  const slash = String(ref || '').indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
};
const conflict = (code, message, extra = {}, fatal = false) => ({ code, message, fatal, ...extra });

function defaultState() {
  return {
    version: 1,
    selectedKeyId: '',
    authorizedProviderIds: [],
    adoptedProviderIds: [],
    managed: { models: [], aliases: {}, groups: {} },
    providers: {},
    disabledBySync: false,
    pendingWrite: null,
    suppressedModels: {},
    suppressedAliases: {},
    conflicts: [],
    lastSuccessAt: 0,
    lastError: '',
  };
}

function cleanSuppressions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item.target === 'string')
    .map(([name, item]) => [name, {
      target: item.target,
      providerIds: Array.isArray(item.providerIds) ? item.providerIds.filter((x) => typeof x === 'string') : [],
    }]));
}

function suppressionProviders(state, target) {
  const groups = { ...(state.managed.groups || {}), ...((state.pendingWrite && state.pendingWrite.groups) || {}) };
  for (const group of Object.values(groups)) {
    if (lower(group.ref) === lower(target)) {
      return unique((group.members || []).map((member) => refParts(member)?.provider).filter(Boolean));
    }
  }
  if (/^(?:group|auto)\//i.test(target)) return [];
  const parts = refParts(target);
  return parts ? [parts.provider] : [];
}

class AliasStateStore {
  constructor(file) {
    this.file = file;
    this.counter = 0;
  }

  read() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return defaultState();
      throw new Error(`无法读取 aliases 同步状态：${e.message}`);
    }
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error('aliases 同步状态已损坏，未自动重置'); }
    if (!data || data.version !== 1 || !Array.isArray(data.authorizedProviderIds)
      || !Array.isArray(data.adoptedProviderIds) || !data.managed
      || !Array.isArray(data.managed.models) || !data.managed.aliases
      || typeof data.managed.aliases !== 'object' || Array.isArray(data.managed.aliases)
      || !data.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) {
      throw new Error('aliases 同步状态结构不兼容，未自动重置');
    }
    return {
      ...defaultState(), ...data,
      selectedKeyId: typeof data.selectedKeyId === 'string' ? data.selectedKeyId : '',
      authorizedProviderIds: unique(data.authorizedProviderIds.filter((x) => typeof x === 'string')),
      adoptedProviderIds: unique(data.adoptedProviderIds.filter((x) => typeof x === 'string')),
      disabledBySync: !!data.disabledBySync,
      pendingWrite: data.pendingWrite && typeof data.pendingWrite === 'object' && !Array.isArray(data.pendingWrite) ? {
        managedModels: Array.isArray(data.pendingWrite.managedModels)
          ? data.pendingWrite.managedModels.filter((x) => typeof x === 'string') : [],
        managedAliases: data.pendingWrite.managedAliases && typeof data.pendingWrite.managedAliases === 'object'
          && !Array.isArray(data.pendingWrite.managedAliases) ? data.pendingWrite.managedAliases : {},
        groups: data.pendingWrite.groups && typeof data.pendingWrite.groups === 'object' ? data.pendingWrite.groups : {},
      } : null,
      suppressedModels: cleanSuppressions(data.suppressedModels),
      suppressedAliases: cleanSuppressions(data.suppressedAliases),
      conflicts: Array.isArray(data.conflicts) ? data.conflicts.filter((c) => c && typeof c.code === 'string') : [],
      managed: {
        models: unique(data.managed.models.filter((x) => typeof x === 'string')),
        aliases: Object.fromEntries(Object.entries(data.managed.aliases)
          .filter(([name, target]) => name && typeof target === 'string')),
        groups: data.managed.groups && typeof data.managed.groups === 'object' ? data.managed.groups : {},
      },
    };
  }

  write(state) {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${path.basename(this.file)}.${process.pid}.${++this.counter}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 保留原错误 */ }
      throw e;
    }
  }
}

function keyEligibility(key, { allowSyncOff = false, now = Date.now() } = {}) {
  if (!key) return { eligible: false, reason: 'Key 不存在' };
  if (key.lan) return { eligible: false, reason: '默认 LAN Key 不能作为同步目标' };
  if (key.off && !(allowSyncOff && key.offBySync)) return { eligible: false, reason: 'Key 已禁用' };
  if (key.readOnly) return { eligible: false, reason: '只读 Key 不能调用模型' };
  if (key.browser) return { eligible: false, reason: '浏览器扩展专用 Key 不能作为同步目标' };
  if (key.issuer) return { eligible: false, reason: '签发型临时 Key 不能作为同步目标' };
  if (key.expires) {
    const at = Date.parse(key.expires);
    if (!Number.isFinite(at) || at <= now) return { eligible: false, reason: 'Key 已过期或过期时间无效' };
  }
  return { eligible: true, reason: '' };
}

function readCallerKeys(file) {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error('magpie caller-keys.json 结构不兼容');
  return data.filter((k) => k && typeof k.id === 'string').map((k) => ({
    id: k.id,
    name: typeof k.name === 'string' ? k.name : k.id,
    off: !!k.off,
    lan: !!k.lan,
    models: Array.isArray(k.models) ? k.models.filter((m) => typeof m === 'string') : [],
    aliases: k.aliases && typeof k.aliases === 'object' && !Array.isArray(k.aliases) ? { ...k.aliases } : {},
    accounts: Array.isArray(k.accounts) ? k.accounts.filter((a) => typeof a === 'string') : [],
    expires: k.expires || '',
    issuer: k.issuer || '',
    readOnly: !!k.readOnly,
    browser: !!k.browser,
    admin: k.admin || '',
  }));
}

function providerSource(id, row) {
  if (PROVIDER_IDS.has(id)) return 'self-hosted';
  if (row && (row.account || row.plugin || row.move)) return 'community';
  return 'local';
}

function activeModels(row) {
  if (!row) return { known: true, ids: [], removed: true };
  if (row.off || row.noModels) return { known: true, ids: [] };
  if (!Array.isArray(row.models)) return { known: false, ids: [] };
  const ids = row.models.filter((m) => m && m.on === true && typeof m.id === 'string' && m.id)
    .map((m) => m.id);
  // 非空列表全部 off 是用户明确关闭；空列表且没有 noModels 则可能只是尚未拉取。
  if (!ids.length && row.models.length === 0) return { known: false, ids: [] };
  return { known: true, ids: unique(ids) };
}

function groupKeyAllowed(group, keyId) {
  if (group.keys === undefined || group.keys === null) return true;
  if (!Array.isArray(group.keys)) return false;
  const positive = [];
  for (const raw of group.keys) {
    if (typeof raw !== 'string' || !raw || /[*?]/.test(raw) || /^re:/i.test(raw)) return false;
    if (raw.startsWith('!')) {
      if (lower(raw.slice(1)) === lower(keyId)) return false;
    } else positive.push(raw);
  }
  return !positive.length || positive.some((id) => lower(id) === lower(keyId));
}

function safeGroupTarget(group, alias, targets, keyId) {
  if (!group || !Array.isArray(group.members) || !group.members.length) return { ok: false, reason: '路由组没有静态成员' };
  if ((Array.isArray(group.patterns) && group.patterns.length)
    || group.match || group.matched || group.dynamic || group.pattern) {
    return { ok: false, reason: '路由组包含动态匹配成员' };
  }
  if (!groupKeyAllowed(group, keyId)) return { ok: false, reason: '路由组 keys 绑定不包含目标 Key' };
  const members = group.members.map((member) => {
    if (typeof member !== 'string' || member.includes('#') || /:[^/]*$/.test(member)) return '';
    return member;
  });
  if (members.some((m) => !m || m.startsWith('group/'))) return { ok: false, reason: '路由组含账号、effort 或嵌套组成员' };
  if (unique(members).length !== members.length) return { ok: false, reason: '路由组包含重复成员' };
  const wanted = unique(targets);
  if (!sameSet(members, wanted)) return { ok: false, reason: '路由组成员与已授权的同名模型不完全一致' };
  const ref = typeof group.ref === 'string' && group.ref ? group.ref : (!group.auto ? `group/${group.id}` : '');
  if (!ref || ref.includes('*') || /^re:/i.test(ref)) return { ok: false, reason: '路由组公开 ref 无效' };
  return { ok: true, ref };
}

function buildPlan({ key, providers, groups, authorizedProviderIds, providerCache }) {
  const conflicts = [];
  const byModel = new Map();
  const providerStates = [];
  for (const pid of authorizedProviderIds) {
    const row = providers.find((p) => p && p.id === pid);
    let active = activeModels(row);
    let stale = false;
    if (!active.known && providerCache[pid] && Array.isArray(providerCache[pid].models)) {
      active = { known: true, ids: providerCache[pid].models };
      stale = true;
    }
    if (providerCache[pid] && providerCache[pid].error) stale = true;
    providerStates.push({ row, active, stale });
    if (!active.known) {
      conflicts.push(conflict('provider-models-unknown', `${pid} 的模型目录未知，本轮停止权限写入`, { providerIds: [pid] }, true));
      continue;
    }
    if (stale) conflicts.push(conflict('provider-models-stale', `${pid} 刷新失败，暂沿用上次模型目录`, { providerIds: [pid] }));
    if (active.removed) conflicts.push(conflict('provider-removed', `${pid} 已从 magpie 移除，将撤销其托管项`, { providerIds: [pid] }));
    for (const modelId of active.ids) {
      const name = aliasOf(modelId);
      if (!name || name.length > 120 || /[\s*=]/.test(name) || name.startsWith('re:')) {
        conflicts.push(conflict('alias-invalid', `${pid}/${modelId} 无法生成合法裸模型名`, { model: modelId, providerIds: [pid] }));
        continue;
      }
      const normalized = lower(name);
      if (!byModel.has(normalized)) byModel.set(normalized, { name, targets: [] });
      byModel.get(normalized).targets.push(`${pid}/${modelId}`);
    }
  }

  const desiredModels = new Map();
  const desiredAliases = new Map();
  const groupSnapshots = {};
  for (const item of byModel.values()) {
    const targets = unique(item.targets);
    let target = '';
    if (targets.length === 1) {
      target = targets[0];
    } else {
      const candidates = groups.filter((g) => g && (g.auto
        ? lower(g.ref) === lower(`auto/${item.name}`) || lower(g.name) === lower(item.name)
        : lower(g.name) === lower(item.name)));
      if (candidates.length !== 1) {
        conflicts.push(conflict(candidates.length ? 'group-ambiguous' : 'group-required',
          candidates.length ? `裸名 ${item.name} 有多个同名路由组，未自动选择` : `裸名 ${item.name} 跨多个 provider，但没有对应路由组`,
          { model: item.name, providerIds: targets.map((r) => refParts(r).provider) }));
      } else {
        const safe = safeGroupTarget(candidates[0], item.name, targets, key.id);
        if (!safe.ok) {
          conflicts.push(conflict('group-unsafe', `裸名 ${item.name} 的路由组不可用：${safe.reason}`,
            { model: item.name, groupId: candidates[0].id, providerIds: targets.map((r) => refParts(r).provider) }));
        } else {
          target = safe.ref;
          groupSnapshots[lower(item.name)] = {
            ref: safe.ref,
            members: [...candidates[0].members],
            keys: Array.isArray(candidates[0].keys) ? [...candidates[0].keys] : [],
          };
        }
      }
    }
    if (!target) continue;
    desiredModels.set(lower(target), target);
    desiredAliases.set(lower(item.name), { name: item.name, target });
  }
  return { desiredModels, desiredAliases, groupSnapshots, conflicts, providerStates };
}

function mergePlan({ key, state, planned }) {
  const conflicts = [...planned.conflicts];
  const currentModels = unique(key.models);
  const currentAliases = key.aliases && typeof key.aliases === 'object' ? key.aliases : {};
  const pending = state.pendingWrite || { managedModels: [], managedAliases: {} };
  // 崩溃日志只在“当前值等于待写值”时证明该项由同步器写过；缺失项允许下次重试。
  const confirmedModels = pending.managedModels.filter((ref) => currentModels.some((m) => lower(m) === lower(ref)));
  const oldModels = unique([...state.managed.models, ...confirmedModels]);
  const oldAliases = { ...(state.managed.aliases || {}) };
  for (const [name, target] of Object.entries(pending.managedAliases || {})) {
    const current = Object.entries(currentAliases).find(([alias]) => lower(alias) === lower(name));
    if (current && lower(current[1]) === lower(target)) oldAliases[current[0]] = target;
  }
  const adoption = new Set(state.authorizedProviderIds.filter((pid) => !state.adoptedProviderIds.includes(pid)));
  const ownsRef = (ref, pid) => lower(ref) === `${lower(pid)}/*` || lower(ref).startsWith(`${lower(pid)}/`);
  const oldModelSet = new Set(oldModels.map(lower));
  const desiredModels = new Map(planned.desiredModels);
  const desiredAliases = new Map(planned.desiredAliases);
  const suppressedModels = { ...(state.suppressedModels || {}) };
  const suppressedAliases = { ...(state.suppressedAliases || {}) };
  for (const [normalized, entry] of Object.entries(suppressedModels)) {
    if (!desiredModels.has(normalized)) continue;
    desiredModels.delete(normalized);
    conflicts.push(conflict('suppressed-model', `${entry.target} 曾被外部删除，只有重新授权对应 provider 才会恢复`, {
      model: entry.target, providerIds: entry.providerIds,
    }));
  }
  for (const [normalized, entry] of Object.entries(suppressedAliases)) {
    if (!desiredAliases.has(normalized)) continue;
    desiredAliases.delete(normalized);
    conflicts.push(conflict('suppressed-alias', `alias ${normalized} 曾被外部删除或修改，只有重新授权对应 provider 才会恢复`, {
      model: normalized, providerIds: entry.providerIds,
    }));
  }

  if (!currentModels.length && planned.desiredModels.size > 0
    && (oldModels.length || state.authorizedProviderIds.length)) {
    conflicts.push(conflict('models-unrestricted', '目标 Key 当前 Models 为空（可能是不限制），已停止自动写入', {}, true));
  }

  const blockedModels = new Set();
  for (const ref of oldModels) {
    const still = currentModels.some((m) => lower(m) === lower(ref));
    if (!still && desiredModels.has(lower(ref)) && ![...adoption].some((pid) => ownsRef(ref, pid))) {
      conflicts.push(conflict('external-model-delete', `${ref} 曾是托管权限但已被外部删除，不自动抢回`, { model: ref }));
      blockedModels.add(lower(ref));
      suppressedModels[lower(ref)] = { target: ref, providerIds: suppressionProviders(state, ref) };
    }
  }
  const preservedModels = currentModels.filter((ref) => {
    if (oldModelSet.has(lower(ref))) return false;
    if ([...adoption].some((pid) => ownsRef(ref, pid))) return false;
    return true;
  });

  const currentAliasEntries = Object.entries(currentAliases);
  const oldAliasNames = new Map(Object.keys(oldAliases).map((name) => [lower(name), name]));
  const preservedAliases = {};
  for (const [name, target] of currentAliasEntries) {
    const normalized = lower(name);
    const oldName = oldAliasNames.get(normalized);
    const oldTarget = oldName ? oldAliases[oldName] : undefined;
    if (oldName) {
      if (lower(oldTarget) !== lower(target)) {
        preservedAliases[name] = target;
        conflicts.push(conflict('external-alias', `alias ${name} 已被外部修改，保留用户值`, { model: name }));
        desiredAliases.delete(normalized);
        suppressedAliases[normalized] = { target: oldTarget, providerIds: suppressionProviders(state, oldTarget) };
      }
      continue;
    }
    const parts = refParts(target);
    const adopt = parts && [...adoption].some((pid) => ownsRef(target, pid))
      && lower(name) === lower(aliasOf(parts.model));
    if (adopt) continue;
    preservedAliases[name] = target;
    if (desiredAliases.has(normalized)) {
      conflicts.push(conflict('manual-alias-conflict', `裸名 ${name} 已有手工映射，未覆盖`, { model: name }));
      desiredAliases.delete(normalized);
    }
  }
  for (const [oldName, oldTarget] of Object.entries(oldAliases)) {
    const normalized = lower(oldName);
    const exists = currentAliasEntries.some(([name]) => lower(name) === normalized);
    if (!exists && desiredAliases.has(normalized)) {
      conflicts.push(conflict('external-alias-delete', `alias ${oldName} 已被外部删除，不自动抢回（旧目标 ${oldTarget}）`, { model: oldName }));
      desiredAliases.delete(normalized);
      suppressedAliases[normalized] = { target: oldTarget, providerIds: suppressionProviders(state, oldTarget) };
    }
  }

  for (const [normalized, item] of [...desiredAliases]) {
    const duplicate = Object.entries(preservedAliases).find(([name, target]) => lower(name) !== normalized && lower(target) === lower(item.target));
    if (duplicate) {
      conflicts.push(conflict('duplicate-target', `${item.name} 与手工 alias ${duplicate[0]} 指向同一目标，未生成重复映射`, { model: item.name }));
      desiredAliases.delete(normalized);
    }
  }
  for (const ref of blockedModels) desiredModels.delete(ref);

  const models = [...preservedModels];
  const aliases = { ...preservedAliases };
  for (const [normalized, ref] of desiredModels) {
    if (!models.some((m) => lower(m) === normalized)) models.push(ref);
  }
  for (const [normalized, item] of desiredAliases) aliases[item.name] = item.target;

  if (models.length > MODEL_LIMIT || Object.keys(aliases).length > ALIAS_LIMIT) {
    conflicts.push(conflict('native-limit', `超过 magpie 原生上限（Models ${models.length}/${MODEL_LIMIT}，Aliases ${Object.keys(aliases).length}/${ALIAS_LIMIT}）`, {
      models: models.length, aliases: Object.keys(aliases).length,
    }, true));
  }
  return {
    conflicts, models, aliases,
    managedModels: [...desiredModels.values()],
    managedAliases: Object.fromEntries([...desiredAliases.values()].map((item) => [item.name, item.target])),
    groupSnapshots: planned.groupSnapshots,
    preservedModelCount: preservedModels.length,
    preservedAliasCount: Object.keys(preservedAliases).length,
    suppressedModels,
    suppressedAliases,
  };
}

class MagpieAliasSync {
  constructor({
    dataDir, store, updater, panel, routingGroups, gatewayPanel, magpieDir,
    reconcileMs = 60000, refreshMs = 600000, debounceMs = 50,
  }) {
    if (!dataDir || !store) throw new Error('AliasSync 缺少数据目录或平台配置');
    this.dataDir = dataDir;
    this.store = store;
    this.updater = updater || null;
    this.gatewayPanel = gatewayPanel || null;
    this.panel = panel || new PluginPanel({ getConfig: () => store.getPlatform('magpie-web'), timeoutMs: 45000 });
    this.routingGroups = routingGroups || new RoutingGroups({ getConfig: () => store.getPlatform('magpie-web'), timeoutMs: 45000 });
    this.callerKeysFile = path.join(magpieDir || magpieConfigDir(), 'caller-keys.json');
    this.stateStore = new AliasStateStore(path.join(dataDir, 'alias-sync.json'));
    this.reconcileMs = reconcileMs;
    this.refreshMs = refreshMs;
    this.debounceMs = debounceMs;
    this.started = false;
    this.closed = false;
    this.revision = 0;
    this.inflight = null;
    this.timer = null;
    this.interval = null;
    this.pending = null;
    this.runtime = { phase: 'idle', lastStartedAt: 0, lastFinishedAt: 0, lastError: '' };
    this.mutationTail = Promise.resolve();
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.interval = setInterval(() => this.request('periodic'), this.reconcileMs);
    this.interval.unref();
    this.request('startup', { refresh: true });
  }

  request(reason, { refresh = false } = {}) {
    if (this.closed) return { ok: false, revision: this.revision, status: this.runtime.phase };
    this.revision++;
    this.pending = { reason, refresh: !!(this.pending?.refresh || refresh) };
    if (!this.started) return { ok: true, revision: this.revision, status: this.runtime.phase };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this._drain().catch(() => {}); }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
    return { ok: true, revision: this.revision, status: this.runtime.phase };
  }

  async _drain() {
    if (this.inflight || this.closed || !this.pending) return this.inflight;
    const pending = this.pending;
    this.pending = null;
    const revision = this.revision;
    this.inflight = this._execute(revision, pending).finally(() => {
      this.inflight = null;
      if (this.pending && !this.closed) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this._drain().catch(() => {}); }, this.debounceMs);
        if (this.timer.unref) this.timer.unref();
      }
    });
    return this.inflight;
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    while (this.pending || this.inflight) {
      if (!this.inflight) await this._drain();
      else await this.inflight;
      if (this.pending && !this.inflight) await this._drain();
    }
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
    this.pending = null;
    if (this.inflight) await this.inflight.catch(() => {});
  }

  _checkRevision(revision) {
    if (this.closed || revision !== this.revision) {
      const e = new Error('同步配置已变化，旧代次停止写入');
      e.code = 'STALE_SYNC';
      throw e;
    }
  }

  /** 原生写已完成后只合并实际进度；旧代次绝不能把最新授权选择覆盖回去。 */
  _progress(revision, state, apply) {
    const target = this.closed || revision !== this.revision ? this.stateStore.read() : state;
    apply(target);
    this.stateStore.write(target);
    this._checkRevision(revision);
  }

  _selected(state, keys) {
    const key = keys.find((k) => k.id === state.selectedKeyId);
    const eligibility = keyEligibility({ ...key, offBySync: state.disabledBySync }, { allowSyncOff: true });
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    return key;
  }

  _assertKeyUnchanged(state, expected) {
    const current = this._selected(state, readCallerKeys(this.callerKeysFile));
    if (!sameSet(current.models, expected.models) || !sameAliases(current.aliases, expected.aliases)) {
      const error = new Error('目标 Key 在同步期间被外部修改，本轮放弃写入并等待重新规划');
      error.code = 'EXTERNAL_KEY_DRIFT';
      throw error;
    }
    return current;
  }

  _mutation(fn) {
    const result = this.mutationTail.then(fn, fn);
    this.mutationTail = result.catch(() => {});
    return result;
  }

  selectKey(keyId) { return this._mutation(() => this._selectKey(keyId)); }

  async _selectKey(keyId) {
    if (this.closed) throw new Error('aliases 同步已关闭');
    if (typeof keyId !== 'string' || !/^[a-z0-9]{8,64}$/i.test(keyId)) throw new Error('Gateway Key 标识无效');
    if (this.inflight || this.pending) throw new Error('同步进行中，完成后再切换目标 Key');
    const state = this.stateStore.read();
    if (state.selectedKeyId !== keyId && (state.managed.models.length || Object.keys(state.managed.aliases).length
      || state.disabledBySync || state.pendingWrite)) {
      throw new Error('当前 Key 仍有同步器托管项，请先撤销全部 provider 授权');
    }
    const key = readCallerKeys(this.callerKeysFile).find((k) => k.id === keyId);
    const eligibility = keyEligibility(key);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    state.selectedKeyId = keyId;
    state.adoptedProviderIds = [];
    state.suppressedModels = {};
    state.suppressedAliases = {};
    state.disabledBySync = false;
    state.conflicts = [];
    state.lastError = '';
    this.stateStore.write(state);
    this.revision++;
    clearTimeout(this.timer);
    this.timer = null;
    // 选择 Key 本身不刷新、不授权，也绝不在尚未授权 provider 时禁用 Key。
    return { ok: true, selectedKeyId: keyId };
  }

  setProvider(providerId, authorized) { return this._mutation(() => this._setProvider(providerId, authorized)); }

  async _setProvider(providerId, authorized) {
    if (this.closed) throw new Error('aliases 同步已关闭');
    if (typeof providerId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(providerId)) throw new Error('provider 标识无效');
    if (typeof authorized !== 'boolean') throw new Error('provider 授权状态无效');
    const initial = this.stateStore.read();
    this._selected(initial, readCallerKeys(this.callerKeysFile));
    const providers = await this._providers();
    // 后台同步可能在上一步等待期间推进托管账本；修改授权前必须基于最新状态。
    const state = this.stateStore.read();
    this._selected(state, readCallerKeys(this.callerKeysFile));
    if (!providers.some((p) => p.id === providerId)) throw new Error('provider 不存在');
    const ids = new Set(state.authorizedProviderIds);
    if (authorized) {
      ids.add(providerId);
      // 明确重新授权才解除该 provider 的外部删除 suppression；周期同步不会自动抢回。
      const clear = (items) => Object.fromEntries(Object.entries(items || {})
        .filter(([, item]) => !(item.providerIds || []).includes(providerId)));
      state.suppressedModels = clear(state.suppressedModels);
      state.suppressedAliases = clear(state.suppressedAliases);
    } else ids.delete(providerId);
    state.authorizedProviderIds = [...ids].sort();
    state.lastError = '';
    this.stateStore.write(state);
    return this.request(authorized ? 'provider-authorized' : 'provider-revoked', { refresh: authorized });
  }

  async _providers() {
    const data = await this.panel._api('providers');
    if (!data || !Array.isArray(data.providers)) throw new Error('magpie provider 响应结构不兼容');
    return data.providers.filter((p) => p && typeof p.id === 'string');
  }

  async _groups() { return this.routingGroups.raw(); }

  async _syncCredentials(state) {
    const results = {};
    if (!this.updater) return results;
    for (const id of SELF_HOSTED) {
      try { results[`wanneng-${id}`] = await this.updater.syncProviderKey(id); }
      catch (e) { results[`wanneng-${id}`] = { ok: false, message: e.message }; }
    }
    return results;
  }

  /**
   * 刷新四家自建 provider 的模型目录，与外网 aliases 授权无关。
   *
   * magpie 只在模型为空时才自动拉取；已安装的 provider 一旦有旧快照就会一直保留，
   * 于是本地 127.0.0.1:17899 的 Gateway 页面看不到上游新增模型（如 kimi-k3.1-pro），
   * 旧模型（如已下架的 GPT）也继续混在目录里。原生 provider/models 会用 Refetch
   * 替换快照并把下架项移入 Delisted：曾全选的 picks 会接住新增模型，用户手工取消的
   * 不会被加回。刷新失败只记录错误，保留上次可用目录。
   */
  /** 各网关自己的真实模型列表（不经 magpie 缓存），失败返回 null。 */
  async _vendorModels(id) {
    if (!this.gatewayPanel) return null;
    try {
      const result = await this.gatewayPanel.models(id);
      const ids = (result && Array.isArray(result.models) ? result.models : [])
        .map((m) => m && m.id).filter((x) => typeof x === 'string' && x);
      return ids.length ? [...new Set(ids)] : null;
    } catch { return null; }
  }

  /**
   * magpie 的 provider/models 只把新模型追加到 picks，不会移除已下架的旧 picks
   * （首次 Refetch 前 catalog 为空时 dropGonePicks 直接跳过）。因此刷新后还要用
   * 网关真实列表收敛 picks，否则已下架的 GPT 会一直留在目录里。
   * 只对四家自建 provider 生效；缺失的高级字段由 magpie 保留。
   */
  async _syncPicks(pid, row, vendor) {
    let current = null;
    try { current = getCustomProvider(pid, path.dirname(this.callerKeysFile)); }
    catch { current = null; }
    const picks = Array.isArray(current?.models) ? current.models.filter((m) => typeof m === 'string') : null;
    if (picks && sameSet(picks, vendor)) return false;
    const payload = { id: pid };
    // provider/save 要求至少一个 base URL；缺失会报 “a provider needs a base URL”。
    for (const key of ['chat', 'responses', 'anthropic', 'gemini', 'name', 'preset', 'icon']) {
      if (typeof row[key] === 'string' && row[key]) payload[key] = row[key];
    }
    for (const key of ['bestInFamily', 'unlisted', 'hiddenDrawers', 'hiddenVideomakers', 'fallback', 'contexts',
      'outputs', 'compacts', 'proxy', 'accountProxies', 'maxConcurrency', 'maxAccounts', 'queueLimit', 'queueWait',
      'maxRPM', 'priceRate', 'rateWindows', 'pinUpstream', 'unredacted', 'countFree', 'billing', 'nativeCompaction',
      'routing', 'affinity', 'sink', 'modelPrefs', 'searches']) {
      if (Object.hasOwn(row, key)) payload[key] = row[key];
    }
    payload.models = [...vendor];
    payload.noModels = false;
    await this.panel._api('provider/save', payload);
    return true;
  }

  async _refreshOwnedModels(state, force) {
    const now = Date.now();
    const refreshed = new Set();
    const conflicts = [];
    let rows;
    try { rows = await this._providers(); }
    catch { return { refreshed, conflicts }; } // 控制台不可用：保留缓存，不算本次状态
    const byId = new Map(rows.map((p) => [p.id, p]));
    for (const id of SELF_HOSTED) {
      const pid = `wanneng-${id}`;
      const current = byId.get(pid);
      if (!current) continue; // 未注册：交给安装/手动注册，不当作刷新失败
      const cached = state.providers[pid] || {};
      if (!force && now - (cached.lastRefreshAt || 0) < this.refreshMs) continue;
      if (current.off || current.noModels) {
        state.providers[pid] = { models: [], lastRefreshAt: now, lastSuccessAt: now, error: '' };
        continue;
      }
      try {
        const result = await this.panel._api('provider/models', { id: pid });
        let row = result && result.provider && typeof result.provider.id === 'string' ? result.provider : null;
        if (!row) row = (await this._providers()).find((p) => p.id === pid) || null;
        const vendor = await this._vendorModels(id);
        const active = activeModels(row);
        const models = vendor || (active.known ? active.ids : (cached.models || []));
        state.providers[pid] = {
          models,
          lastRefreshAt: now,
          lastSuccessAt: (vendor || active.known) ? now : (cached.lastSuccessAt || 0),
          error: (vendor || active.known) ? '' : '刷新后模型目录仍未知',
        };
        if (vendor && row) {
          try { await this._syncPicks(pid, row, vendor); }
          catch (e) { conflicts.push(conflict('model-picks', `${pid} 模型选择收敛失败：${e.message}`, { providerIds: [pid] })); }
          refreshed.add(pid);
        } else if (active.known) refreshed.add(pid);
      } catch (e) {
        state.providers[pid] = { ...cached, lastRefreshAt: now, error: e.message };
        conflicts.push(conflict('model-refresh', `${pid} 模型刷新失败：${e.message}`, { providerIds: [pid] }));
      }
    }
    return { refreshed, conflicts };
  }

  async _collect(state, refresh, skipIds = new Set()) {
    let providers = await this._providers();
    const now = Date.now();
    for (const pid of state.authorizedProviderIds) {
      if (skipIds.has(pid)) continue;
      const cached = state.providers[pid] || {};
      const current = providers.find((p) => p.id === pid);
      if (current && (current.off || current.noModels)) {
        state.providers[pid] = { ...cached, models: [], lastRefreshAt: now, lastSuccessAt: now, error: '' };
        continue;
      }
      if (!refresh && now - (cached.lastRefreshAt || 0) < this.refreshMs) continue;
      try {
        const result = await this.panel._api('provider/models', { id: pid });
        if (result && result.provider && typeof result.provider.id === 'string') {
          providers = providers.filter((p) => p.id !== pid).concat(result.provider);
        } else {
          const latest = await this._providers();
          const row = latest.find((p) => p.id === pid);
          if (row) providers = providers.filter((p) => p.id !== pid).concat(row);
        }
        const row = providers.find((p) => p.id === pid);
        const active = activeModels(row);
        if (!active.known) throw new Error('刷新后模型目录仍未知');
        state.providers[pid] = { models: active.ids, lastRefreshAt: now, lastSuccessAt: now, error: '' };
      } catch (e) {
        state.providers[pid] = { ...cached, lastRefreshAt: now, error: e.message };
      }
    }
    // 模型刷新会改变 auto 组，必须重新取组快照。
    const groups = await this._groups();
    return { providers, groups };
  }

  _updateCaches(state, planned) {
    for (const { row, active, stale } of planned.providerStates) {
      if (!row || !active.known || stale) continue;
      const pid = row.id;
      const previous = state.providers[pid] || {};
      state.providers[pid] = { ...previous, models: active.ids, error: previous.error || '' };
    }
  }

  async _execute(revision, { reason, refresh }) {
    this.runtime.phase = 'syncing';
    this.runtime.lastStartedAt = Date.now();
    this.runtime.lastError = '';
    let state;
    try {
      state = this.stateStore.read();
      const keys = readCallerKeys(this.callerKeysFile);
      const credentials = await this._syncCredentials(state);
      const credentialConflicts = Object.entries(credentials).filter(([, r]) => r && r.ok === false)
        .map(([providerId, r]) => conflict('credential-sync', `${providerId}：${r.message}`, { providerIds: [providerId] }));
      // 先同步四家自建 provider 的模型目录：与本机 Gateway 页面、aliases 授权都无关。
      const owned = await this._refreshOwnedModels(state, refresh);
      this._checkRevision(revision);
      if (!state.selectedKeyId || !state.authorizedProviderIds.length
        && !state.managed.models.length && !Object.keys(state.managed.aliases).length && !state.disabledBySync) {
        state.conflicts = [...credentialConflicts, ...owned.conflicts];
        if (!state.conflicts.length) state.lastSuccessAt = Date.now();
        this.stateStore.write(state);
        this.runtime.phase = state.conflicts.length ? 'partial' : 'idle';
        return;
      }
      let key = this._selected(state, keys);
      const collected = await this._collect(state, refresh, owned.refreshed);
      // 模型刷新可能耗时很久；规划必须使用此刻最新的 caller-key，而不是刷新前快照。
      key = this._selected(state, readCallerKeys(this.callerKeysFile));
      if (!collected.providers.length && state.authorizedProviderIds.length) {
        throw new Error('provider 快照为空，无法确认是否全部移除，本轮停止权限写入');
      }
      this._checkRevision(revision);
      const planned = buildPlan({
        key, providers: collected.providers, groups: collected.groups,
        authorizedProviderIds: state.authorizedProviderIds, providerCache: state.providers,
      });
      this._updateCaches(state, planned);
      const merged = mergePlan({ key, state, planned });
      state.suppressedModels = merged.suppressedModels;
      state.suppressedAliases = merged.suppressedAliases;
      state.conflicts = [...credentialConflicts, ...owned.conflicts, ...merged.conflicts]
        .map(({ fatal, ...item }) => item);
      if (merged.conflicts.some((c) => c.fatal)) throw new Error(merged.conflicts.find((c) => c.fatal).message);
      const hasManagedWork = state.authorizedProviderIds.length || state.managed.models.length
        || Object.keys(state.managed.aliases).length || state.disabledBySync;
      const hadManaged = state.managed.models.length || Object.keys(state.managed.aliases).length || state.disabledBySync;
      if (!hasManagedWork) {
        this._checkRevision(revision);
        this.stateStore.write(state);
      } else if (!merged.managedModels.length && !merged.preservedModelCount
        && !merged.preservedAliasCount && !key.accounts.length && hadManaged) {
        // Models 空列表可能是不限制。最后撤销只禁用，不把旧 Models/Aliases 写成空。
        if (!key.off) {
          this._checkRevision(revision);
          this._assertKeyUnchanged(state, key);
          await this.panel.callerKey('off-key', key.id);
          this._progress(revision, state, (target) => { target.disabledBySync = true; target.pendingWrite = null; });
        }
      } else {
        if (!merged.models.length) throw new Error('仍有手工 aliases 或 Accounts 限制，不能安全收敛为空；请使用专用 Key 或先在 magpie 处理');
        this._checkRevision(revision);
        if (!sameSet(key.models, merged.models)) {
          this._assertKeyUnchanged(state, key);
          state.pendingWrite = { managedModels: merged.managedModels, managedAliases: {}, groups: merged.groupSnapshots };
          this.stateStore.write(state);
          await this.panel.callerKey('models-key', key.id, { models: merged.models });
          const verified = this._selected(state, readCallerKeys(this.callerKeysFile));
          if (!sameSet(verified.models, merged.models)) throw new Error('Models 写入后回读不一致');
          this._progress(revision, state, (target) => {
            target.managed.models = merged.managedModels;
            target.managed.groups = merged.groupSnapshots;
            target.pendingWrite = null;
          });
        }
        const currentAliases = this._assertKeyUnchanged(state, { ...key, models: merged.models }).aliases;
        if (!sameAliases(currentAliases, merged.aliases)) {
          state.pendingWrite = { managedModels: merged.managedModels, managedAliases: merged.managedAliases, groups: merged.groupSnapshots };
          this.stateStore.write(state);
          await this.panel.callerKey('aliases-key', key.id, { aliases: merged.aliases });
          const verified = this._selected(state, readCallerKeys(this.callerKeysFile));
          if (!sameAliases(verified.aliases, merged.aliases)) throw new Error('Aliases 写入后回读不一致');
        }
        this._progress(revision, state, (target) => {
          target.managed.models = merged.managedModels;
          target.managed.aliases = merged.managedAliases;
          target.managed.groups = merged.groupSnapshots;
          target.adoptedProviderIds = [...state.authorizedProviderIds];
          target.pendingWrite = null;
        });
        if (key.off && state.disabledBySync) {
          this._assertKeyUnchanged(state, { ...key, models: merged.models, aliases: merged.aliases });
          await this.panel.callerKey('on-key', key.id);
          this._progress(revision, state, (target) => { target.disabledBySync = false; target.pendingWrite = null; });
        }
      }
      state.lastSuccessAt = Date.now();
      state.lastError = '';
      this._checkRevision(revision);
      this.stateStore.write(state);
      this.runtime.phase = state.conflicts.length ? 'partial' : 'idle';
    } catch (e) {
      this.runtime.phase = 'error';
      this.runtime.lastError = e.message;
      if (state && e.code !== 'STALE_SYNC') {
        state.lastError = e.message;
        try { this.stateStore.write(state); } catch { /* 保留原始同步错误 */ }
      }
      if (e.code !== 'STALE_SYNC') throw e;
    } finally {
      this.runtime.lastFinishedAt = Date.now();
      if (this.runtime.phase === 'syncing') this.runtime.phase = 'idle';
    }
  }

  async runNow(options = {}) {
    this.revision++;
    this.pending = { reason: options.reason || 'manual', refresh: options.refresh !== false };
    await this.flush();
    if (this.runtime.lastError) throw new Error(this.runtime.lastError);
    return this.status();
  }

  async status() {
    const runtime = { ...this.runtime, revision: this.revision, pending: !!this.pending };
    try {
      const state = this.stateStore.read();
      const keys = readCallerKeys(this.callerKeysFile).map((key) => ({
        id: key.id, name: key.name, off: key.off, accountsRestricted: key.accounts.length > 0,
        ...keyEligibility({ ...key, offBySync: state.disabledBySync && key.id === state.selectedKeyId }, { allowSyncOff: true }),
      }));
      let providers = [];
      try {
        providers = (await this._providers()).map((row) => {
          const active = activeModels(row);
          const cached = state.providers[row.id];
          const known = active.known || Array.isArray(cached?.models);
          return {
            id: row.id, name: row.name || row.id, source: providerSource(row.id, row),
            off: !!row.off, ready: !!row.ready, authorized: state.authorizedProviderIds.includes(row.id),
            modelCount: known ? (active.known ? active.ids.length : cached.models.length) : null,
            modelCountKnown: known,
            credential: PROVIDER_IDS.has(row.id) ? 'config' : 'magpie',
            lastRefreshAt: cached?.lastRefreshAt || 0,
            lastSuccessAt: cached?.lastSuccessAt || 0,
            error: cached?.error || '',
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) {
        return {
          available: false, selectedKeyId: state.selectedKeyId, keys, providers,
          authorizedCount: state.authorizedProviderIds.length,
          usage: { aliases: { used: Object.keys(state.managed.aliases).length, limit: ALIAS_LIMIT }, models: { used: state.managed.models.length, limit: MODEL_LIMIT } },
          conflicts: state.conflicts, status: runtime, stateError: e.message,
        };
      }
      const selected = readCallerKeys(this.callerKeysFile).find((k) => k.id === state.selectedKeyId);
      return {
        available: true,
        selectedKeyId: state.selectedKeyId,
        selectedKeyName: selected?.name || '',
        keys, providers,
        authorizedCount: state.authorizedProviderIds.length,
        usage: {
          aliases: { used: selected ? Object.keys(selected.aliases).length : 0, managed: Object.keys(state.managed.aliases).length, limit: ALIAS_LIMIT },
          models: { used: selected ? selected.models.length : 0, managed: state.managed.models.length, limit: MODEL_LIMIT },
        },
        conflicts: state.conflicts,
        disabledBySync: state.disabledBySync,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        status: runtime,
      };
    } catch (e) {
      return {
        available: false, selectedKeyId: '', keys: [], providers: [], authorizedCount: 0,
        usage: { aliases: { used: 0, limit: ALIAS_LIMIT }, models: { used: 0, limit: MODEL_LIMIT } },
        conflicts: [], status: runtime, stateError: e.message,
      };
    }
  }
}

module.exports = {
  MagpieAliasSync,
  AliasStateStore,
  defaultState,
  readCallerKeys,
  keyEligibility,
  activeModels,
  safeGroupTarget,
  buildPlan,
  mergePlan,
  aliasOf,
  ALIAS_LIMIT,
  MODEL_LIMIT,
};
