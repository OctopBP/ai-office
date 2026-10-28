/**
 * Замер памяти и нагрузки офиса (T-706).
 *
 * Два раза «проверки main красные» оказывались перегрузом машины, а не кодом
 * (T-659, T-693), и оба раза смотреть было не на что: load average и память
 * никто не записывал. Здесь раз в 30 с снимается срез — нагрузка системы,
 * ядра, свободная память, RSS и heap процесса сервера, живые сессии агентов
 * по офисам и проверки из общего ограничителя (checkslots.ts, F-70).
 *
 * Срезы лежат в кольцевом буфере за 24 ч только в памяти: на диск ничего не
 * пишется, после перезапуска ряд начинается заново. Отдаёт их
 * `GET /api/resources?office=<id>` — последний срез и ряд.
 *
 * Запуск теста: npm run test:resources
 */
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { checkSlots } from './checkslots';

/** Шаг замера. */
export const RESOURCES_INTERVAL_MS = 30_000;
/** Глубина ряда. */
export const RESOURCES_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Живые сессии агентов одного офиса. */
export interface OfficeSessions {
  /** Идущие сессии исполнителей (занятые слоты офиса). */
  workers: number;
  /** Живые сессии менеджера (цикл чтения запущен, сессия не спит). */
  pm: number;
}

/** Один срез. */
export interface ResourceSample {
  at: number;
  /** os.loadavg(): за 1, 5 и 15 минут. */
  load: [number, number, number];
  cpus: number;
  freeMem: number;
  totalMem: number;
  /** Память процесса сервера. */
  rss: number;
  heapUsed: number;
  heapTotal: number;
  /** Все живые сессии агентов процесса (исполнители + менеджеры всех офисов). */
  sessions: number;
  /** Проверки, держащие слот ограничителя, и ждущие в его очереди. */
  checks: { running: number; waiting: number; limit: number };
  /** Сессии по офисам. */
  offices: Record<string, OfficeSessions>;
}

/** Откуда брать сессии и проверки — подставляется в тесте. */
export interface ResourceSources {
  offices(): { id: string; sessions: OfficeSessions }[];
  checks?(): { running: number; waiting: number; limit: number };
  now?(): number;
}

function sharedChecks(): { running: number; waiting: number; limit: number } {
  const slots = checkSlots();
  return { running: slots.running().length, waiting: slots.waiting().length, limit: slots.limit() };
}

/** Снимает один срез. */
export function takeSample(src: ResourceSources): ResourceSample {
  const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
  const mem = process.memoryUsage();
  const offices: Record<string, OfficeSessions> = {};
  let sessions = 0;
  for (const o of src.offices()) {
    offices[o.id] = { workers: o.sessions.workers, pm: o.sessions.pm };
    sessions += o.sessions.workers + o.sessions.pm;
  }
  return {
    at: src.now?.() ?? Date.now(),
    load: [l1, l5, l15],
    cpus: cpus().length,
    freeMem: freemem(),
    totalMem: totalmem(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    sessions,
    checks: (src.checks ?? sharedChecks)(),
    offices,
  };
}

/** Кольцевой буфер срезов за окно: старше окна выпадает, размер не растёт. */
export class ResourceRing {
  private readonly cap: number;
  private readonly buf: ResourceSample[] = [];
  private head = 0;

  constructor(readonly windowMs = RESOURCES_WINDOW_MS, intervalMs = RESOURCES_INTERVAL_MS) {
    // Запас в один срез: таймер дрожит, и ровно на границе окна не теряем точку.
    this.cap = Math.ceil(windowMs / intervalMs) + 1;
  }

  get capacity(): number { return this.cap; }

  push(s: ResourceSample): void {
    if (this.buf.length < this.cap) this.buf.push(s);
    else { this.buf[this.head] = s; this.head = (this.head + 1) % this.cap; }
  }

  /** Ряд в порядке времени, только за окно от последнего среза. */
  series(): ResourceSample[] {
    const ordered = this.buf.length < this.cap
      ? this.buf.slice()
      : [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
    const last = ordered[ordered.length - 1];
    if (!last) return [];
    const from = last.at - this.windowMs;
    return ordered.filter((s) => s.at >= from);
  }

  latest(): ResourceSample | null {
    if (!this.buf.length) return null;
    return this.buf.length < this.cap ? this.buf[this.buf.length - 1]! : this.buf[(this.head + this.cap - 1) % this.cap]!;
  }

  get size(): number { return this.buf.length; }
}

/** Срез глазами одного офиса: его сессии отдельным полем, чужие — только суммой. */
export interface OfficeResourceSample extends Omit<ResourceSample, 'offices'> {
  office: OfficeSessions;
}

export interface ResourcesAnswer {
  office: string;
  intervalMs: number;
  windowMs: number;
  latest: OfficeResourceSample | null;
  series: OfficeResourceSample[];
}

function forOffice(s: ResourceSample, officeId: string): OfficeResourceSample {
  const { offices, ...rest } = s;
  return { ...rest, office: offices[officeId] ?? { workers: 0, pm: 0 } };
}

/** Ответ маршрута по буферу. */
export function resourcesAnswer(ring: ResourceRing, officeId: string): ResourcesAnswer {
  const series = ring.series().map((s) => forOffice(s, officeId));
  return {
    office: officeId,
    intervalMs: RESOURCES_INTERVAL_MS,
    windowMs: ring.windowMs,
    latest: series[series.length - 1] ?? null,
    series,
  };
}

let ring: ResourceRing | null = null;
let timer: NodeJS.Timeout | null = null;

/** Общий буфер процесса. */
export function resourceRing(): ResourceRing {
  if (!ring) ring = new ResourceRing();
  return ring;
}

/** Запускает замер: первый срез сразу, дальше по шагу. Повторный вызов ничего не делает. */
export function startResources(src: ResourceSources, intervalMs = RESOURCES_INTERVAL_MS): void {
  if (timer) return;
  const r = resourceRing();
  const tick = () => {
    try { r.push(takeSample(src)); } catch (err) { console.warn('[resources]', err); }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

export function stopResources(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
