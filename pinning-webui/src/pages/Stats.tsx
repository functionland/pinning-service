import { useState, useEffect, useId, type ReactNode } from 'react';

// Public, unauthenticated network stats endpoint. This lives on a DIFFERENT
// origin than the web UI, so we MUST use an absolute URL and NO credentials
// (the backend sends `Access-Control-Allow-Origin: *`).
const STATS_URL = 'https://api.cloud.fx.land/api/v1/public-stats';

interface WindowStats {
  users: number;
  uploads: number;
  stored_bytes: number;
  cids: number;
  websites: number;
  fula_spent: number;
}

interface DailyStat extends WindowStats {
  day: string;
}

interface Totals extends WindowStats {
  co2_saved_kg: number;
}

interface PublicStats {
  generated_at: string;
  totals: Totals;
  windows: {
    today: WindowStats;
    '7d': WindowStats;
    '30d': WindowStats;
  };
  daily: DailyStat[];
}

const WINDOWS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
] as const;

type WindowKey = (typeof WINDOWS)[number]['key'];

const EMPTY_WINDOW: WindowStats = {
  users: 0,
  uploads: 0,
  stored_bytes: 0,
  cids: 0,
  websites: 0,
  fula_spent: 0,
};

// ---------- formatting helpers ----------

// Mirrors Dashboard.tsx's formatBytes, hardened for non-positive / huge inputs.
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatNumber(n: number): string {
  if (!n || !isFinite(n)) return '0';
  return Math.round(n).toLocaleString();
}

function formatFula(n: number): string {
  if (!n || !isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// ---------- tiny inline icons (stroke, decorative) ----------

function IconWrap({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const IconUsers = (
  <IconWrap>
    <path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0" />
  </IconWrap>
);
const IconStorage = (
  <IconWrap>
    <path d="M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01" />
  </IconWrap>
);
const IconUpload = (
  <IconWrap>
    <path d="M12 15V4m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </IconWrap>
);
const IconHash = (
  <IconWrap>
    <path d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15" />
  </IconWrap>
);
const IconGlobe = (
  <IconWrap>
    <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.5 2.5 15.5 0 18m0-18C9.5 5.5 9.5 20.5 12 21M3.5 9h17M3.5 15h17" />
  </IconWrap>
);
const IconCurrency = (
  <IconWrap>
    <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5v9M9.5 10a2.5 2.5 0 0 1 5 0c0 1.4-1.1 2-2.5 2s-2.5.6-2.5 2a2.5 2.5 0 0 0 5 0" />
  </IconWrap>
);
const IconLeaf = (
  <IconWrap>
    <path d="M5 18C5 10 11 5 19 5c0 8-5 14-13 14a6 6 0 0 1-1-.05ZM9 15c2-3 5-5 8-6" />
  </IconWrap>
);

// ---------- KPI card ----------

function KpiCard({
  label,
  value,
  caption,
  icon,
}: {
  label: string;
  value: string;
  caption?: string;
  icon: ReactNode;
}) {
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="text-3xl font-bold text-gray-900 mt-1 break-words">{value}</p>
          {caption && <p className="text-xs text-gray-400 mt-1">{caption}</p>}
        </div>
        <div className="shrink-0 w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center text-primary-600">
          {icon}
        </div>
      </div>
    </div>
  );
}

// ---------- hand-rolled, dependency-free responsive SVG charts ----------

const CHART_W = 800;
const CHART_H = 240;
const CHART_PAD_X = 6;
const CHART_PAD_Y = 12;

const GRID_LINES = [0, 0.25, 0.5, 0.75, 1];

function AreaChart({ values, label }: { values: number[]; label: string }) {
  // Unique id so the gradient <defs> never collides if this chart is reused.
  const gradientId = `statsAreaFill-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const n = values.length;
  const plotW = CHART_W - CHART_PAD_X * 2;
  const plotH = CHART_H - CHART_PAD_Y * 2;
  const max = Math.max(0, ...values);
  const denom = max === 0 ? 1 : max; // guard division-by-zero on all-zero data
  const baseline = CHART_PAD_Y + plotH;

  const xAt = (i: number) =>
    CHART_PAD_X + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => CHART_PAD_Y + plotH - (v / denom) * plotH;

  const line =
    n > 0
      ? values
          .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`)
          .join(' ')
      : '';
  const area =
    n > 0
      ? `${line} L${xAt(n - 1).toFixed(2)},${baseline.toFixed(2)} L${xAt(0).toFixed(2)},${baseline.toFixed(2)} Z`
      : '';

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width={CHART_W}
      height={CHART_H}
      className="w-full h-auto"
      role="img"
      aria-label={label}
    >
      {GRID_LINES.map((f) => {
        const y = CHART_PAD_Y + plotH * f;
        return (
          <line
            key={f}
            x1={CHART_PAD_X}
            y1={y}
            x2={CHART_W - CHART_PAD_X}
            y2={y}
            stroke="#eef2f7"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary-500)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--color-primary-500)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${gradientId})`} />}
      {line && (
        <path
          d={line}
          fill="none"
          stroke="var(--color-primary-600)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function BarChart({ values, label }: { values: number[]; label: string }) {
  const n = values.length;
  const plotW = CHART_W - CHART_PAD_X * 2;
  const plotH = CHART_H - CHART_PAD_Y * 2;
  const max = Math.max(0, ...values);
  const denom = max === 0 ? 1 : max; // guard division-by-zero on all-zero data
  const baseline = CHART_PAD_Y + plotH;
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(1, slot * 0.6);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width={CHART_W}
      height={CHART_H}
      className="w-full h-auto"
      role="img"
      aria-label={label}
    >
      {GRID_LINES.map((f) => {
        const y = CHART_PAD_Y + plotH * f;
        return (
          <line
            key={f}
            x1={CHART_PAD_X}
            y1={y}
            x2={CHART_W - CHART_PAD_X}
            y2={y}
            stroke="#eef2f7"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {values.map((v, i) => {
        const h = (v / denom) * plotH;
        const x = CHART_PAD_X + i * slot + (slot - barW) / 2;
        const y = baseline - h;
        return (
          <rect
            key={i}
            x={x.toFixed(2)}
            y={y.toFixed(2)}
            width={barW.toFixed(2)}
            height={Math.max(0, h).toFixed(2)}
            rx={1.5}
            fill="var(--color-primary-500)"
          />
        );
      })}
      <line
        x1={CHART_PAD_X}
        y1={baseline}
        x2={CHART_W - CHART_PAD_X}
        y2={baseline}
        stroke="#d1d5db"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ChartCard({
  title,
  subtitle,
  peakLabel,
  firstDay,
  lastDay,
  isEmpty,
  children,
}: {
  title: string;
  subtitle: string;
  peakLabel: string;
  firstDay: string;
  lastDay: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        <span className="text-xs text-gray-400 whitespace-nowrap">{peakLabel}</span>
      </div>
      <p className="text-xs text-gray-400 mb-3">{subtitle}</p>
      <div className="relative">
        {children}
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-gray-400 bg-white/70 rounded-lg px-3 py-1">
              Collecting data — check back soon
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
        <span>{firstDay}</span>
        <span>{lastDay}</span>
      </div>
    </div>
  );
}

// ---------- page ----------

export default function Stats() {
  const [data, setData] = useState<PublicStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeWindow, setActiveWindow] = useState<WindowKey>('7d');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Public, cross-origin GET — explicitly send NO credentials/cookies.
        const res = await fetch(STATS_URL, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json || typeof json !== 'object' || !json.totals || !json.windows) {
          throw new Error('Malformed stats payload');
        }
        if (active) setData(json as PublicStats);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load stats');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [reloadKey]);

  const retry = () => setReloadKey((k) => k + 1);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-primary-100 flex flex-col">
      {/* Hero */}
      <header className="px-4 pt-12 pb-8 sm:pt-16 sm:pb-10">
        <div className="max-w-6xl mx-auto text-center">
          <img
            src="/fxfiles-icon.png"
            alt="FxFiles"
            className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl shadow-lg mx-auto mb-5"
          />
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">
            FxFiles Network Stats
          </h1>
          <p className="mt-3 text-base sm:text-lg text-gray-600 max-w-2xl mx-auto">
            A live look at how the FULA network is growing — files stored, content
            secured, and websites brought online, all powered by decentralized storage.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 text-sm text-gray-500">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary-500"></span>
            </span>
            Live network metrics — this page auto-updates on each visit.
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 pb-12">
        {loading ? (
          <div className="space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-24 mb-3"></div>
                  <div className="h-8 bg-gray-200 rounded w-32"></div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="card animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-32 mb-4"></div>
                  <div className="h-48 bg-gray-100 rounded"></div>
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <div className="card max-w-lg mx-auto text-center py-10">
            <div className="w-14 h-14 rounded-full bg-primary-50 flex items-center justify-center mx-auto mb-4 text-primary-600">
              <IconWrap>
                <path d="M12 8v4m0 4h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" />
              </IconWrap>
            </div>
            <h2 className="text-lg font-semibold text-gray-900">Stats are warming up</h2>
            <p className="text-gray-600 mt-2">
              The network dashboard is being prepared. Please check back in a little while.
            </p>
            <button onClick={retry} className="btn-primary mt-6">
              Try again
            </button>
          </div>
        ) : data ? (
          <StatsContent data={data} activeWindow={activeWindow} onWindowChange={setActiveWindow} />
        ) : null}
      </main>

      {/* Footer */}
      <footer className="text-center py-8 px-4 border-t border-primary-100/60">
        <p className="text-sm text-gray-500">
          Network-wide statistics across the FULA decentralized storage network.
        </p>
        <p className="text-xs text-gray-400 mt-1">
          CO₂ savings are an approximate estimate.
          {data && <> Last updated {formatDateTime(data.generated_at)}.</>}
        </p>
        <a href="/" className="inline-block mt-3 text-primary-600 hover:text-primary-700 font-medium text-sm">
          Go to FxFiles →
        </a>
      </footer>
    </div>
  );
}

function StatsContent({
  data,
  activeWindow,
  onWindowChange,
}: {
  data: PublicStats;
  activeWindow: WindowKey;
  onWindowChange: (w: WindowKey) => void;
}) {
  const t = data.totals;
  const daily: DailyStat[] = Array.isArray(data.daily) ? data.daily : [];
  const win = data.windows[activeWindow] ?? EMPTY_WINDOW;

  // Cumulative uploads across the daily window → a growth curve.
  let running = 0;
  const cumUploads = daily.map((d) => (running += Number(d.uploads) || 0));
  const dailyUsers = daily.map((d) => Number(d.users) || 0);

  const cumMax = Math.max(0, ...cumUploads);
  const usersMax = Math.max(0, ...dailyUsers);
  const firstDay = daily.length ? formatDay(daily[0].day) : '';
  const lastDay = daily.length ? formatDay(daily[daily.length - 1].day) : '';

  const kpis: { label: string; value: string; caption?: string; icon: ReactNode }[] = [
    { label: 'Users', value: formatNumber(t.users), icon: IconUsers },
    { label: 'Stored', value: formatBytes(t.stored_bytes), icon: IconStorage },
    { label: 'Uploads', value: formatNumber(t.uploads), icon: IconUpload },
    { label: 'CIDs', value: formatNumber(t.cids), icon: IconHash },
    { label: 'Websites generated', value: formatNumber(t.websites), icon: IconGlobe },
    { label: 'FULA spent', value: formatFula(t.fula_spent), icon: IconCurrency },
    {
      label: 'CO₂ saved',
      value: `≈ ${formatFula(t.co2_saved_kg)} kg`,
      caption: 'Approximate estimate',
      icon: IconLeaf,
    },
  ];

  const windowLabel =
    WINDOWS.find((w) => w.key === activeWindow)?.label ?? 'This period';

  return (
    <div className="space-y-10">
      {/* GLOBAL NETWORK TOTALS */}
      <section className="relative py-12 px-4 sm:px-8 mb-8 overflow-hidden bg-white/40 rounded-[2.5rem]">
        <h2 className="relative z-20 text-3xl sm:text-5xl font-extrabold text-center text-gray-900 mb-8 sm:mb-12 tracking-tight uppercase drop-shadow-sm">
          Global Network Totals
        </h2>

        {/* Mobile Layout (stacked/grid) */}
        <div className="md:hidden relative z-10 max-w-lg mx-auto flex flex-col gap-4">
          <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none">
            <img src="/bg-icon.png" alt="" className="w-full h-auto object-contain blur-[1px]" />
          </div>
          {kpis.map((k) => (
            <FloatingKpiCard key={k.label} label={k.label} value={k.value} caption={k.caption} icon={k.icon} />
          ))}
        </div>

        {/* Desktop Layout (scattered like the image) */}
        <div className="hidden md:block relative max-w-5xl mx-auto h-[550px] mt-4">
          {/* Central Background Icon */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <img src="/bg-icon.png" alt="" className="w-[450px] opacity-[0.08] blur-[2px] object-contain" />
          </div>

          {/* SVG Connecting Lines */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-40 z-0" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#06B597" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#06B597" stopOpacity="0.1" />
              </linearGradient>
            </defs>
            <path d="M 500 275 Q 300 200 150 150" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
            <path d="M 500 275 Q 350 150 350 120" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
            <path d="M 500 275 Q 650 150 650 120" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
            <path d="M 500 275 Q 850 200 850 180" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
            <path d="M 500 275 Q 250 350 180 320" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
            <path d="M 500 275 Q 450 450 480 430" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
            <path d="M 500 275 Q 750 400 780 380" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" />
          </svg>

          {/* Scattered Cards */}
          <div className="absolute top-[18%] left-[2%] z-10 w-[200px]">
            <FloatingKpiCard label={kpis[0].label} value={kpis[0].value} icon={kpis[0].icon} caption={kpis[0].caption} />
          </div>
          <div className="absolute top-[8%] left-[26%] z-10 w-[220px]">
            <FloatingKpiCard label={kpis[1].label} value={kpis[1].value} icon={kpis[1].icon} caption={kpis[1].caption} />
          </div>
          <div className="absolute top-[6%] right-[24%] z-10 w-[220px]">
            <FloatingKpiCard label={kpis[2].label} value={kpis[2].value} icon={kpis[2].icon} caption={kpis[2].caption} />
          </div>
          <div className="absolute top-[22%] right-[2%] z-10 w-[210px]">
            <FloatingKpiCard label={kpis[3].label} value={kpis[3].value} icon={kpis[3].icon} caption={kpis[3].caption} />
          </div>
          <div className="absolute top-[52%] left-[8%] z-10 w-[230px]">
            <FloatingKpiCard label={kpis[4].label} value={kpis[4].value} icon={kpis[4].icon} caption={kpis[4].caption} />
          </div>
          <div className="absolute top-[72%] left-[40%] z-10 w-[240px]">
            <FloatingKpiCard label={kpis[5].label} value={kpis[5].value} icon={kpis[5].icon} caption={kpis[5].caption} />
          </div>
          <div className="absolute top-[60%] right-[6%] z-10 w-[240px]">
            <FloatingKpiCard label={kpis[6].label} value={kpis[6].value} icon={kpis[6].icon} caption={kpis[6].caption} />
          </div>
        </div>
      </section>

      {/* Recent growth */}
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Recent growth</h2>
          <div className="inline-flex rounded-lg bg-white border border-gray-200 p-1 self-start">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => onWindowChange(w.key)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeWindow === w.key
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500 mb-4">
            New activity <span className="font-medium text-gray-700">{windowLabel.toLowerCase()}</span>
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6">
            <GrowthStat value={`+${formatNumber(win.users)}`} label="new users" />
            <GrowthStat value={`+${formatNumber(win.uploads)}`} label="uploads" />
            <GrowthStat value={`+${formatBytes(win.stored_bytes)}`} label="stored" />
            <GrowthStat value={`+${formatNumber(win.cids)}`} label="CIDs" />
            <GrowthStat value={`+${formatNumber(win.websites)}`} label="websites" />
            <GrowthStat value={`+${formatFula(win.fula_spent)}`} label="FULA spent" />
          </div>
        </div>
      </section>

      {/* Charts */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Growth over time</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartCard
            title="Cumulative uploads"
            subtitle="Total uploads accumulated over the last 30 days"
            peakLabel={`Peak ${formatNumber(cumMax)}`}
            firstDay={firstDay}
            lastDay={lastDay}
            isEmpty={cumMax === 0}
          >
            <AreaChart values={cumUploads} label="Cumulative uploads over the last 30 days" />
          </ChartCard>

          <ChartCard
            title="New users per day"
            subtitle="Daily new users over the last 30 days"
            peakLabel={`Max ${formatNumber(usersMax)}/day`}
            firstDay={firstDay}
            lastDay={lastDay}
            isEmpty={usersMax === 0}
          >
            <BarChart values={dailyUsers} label="Daily new users over the last 30 days" />
          </ChartCard>
        </div>
      </section>
    </div>
  );
}

function FloatingKpiCard({
  label,
  value,
  caption,
  icon,
}: {
  label: string;
  value: string;
  caption?: string;
  icon: ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl p-4 sm:p-5 flex flex-col shadow-lg shadow-gray-200/50 border border-gray-100 hover:-translate-y-1 transition-transform duration-300 w-full">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-600 leading-none">{label}</p>
          <p className="text-2xl sm:text-3xl font-extrabold text-gray-900 mt-2 tracking-tight break-words">{value}</p>
          {caption && <p className="text-xs text-primary-600 font-medium mt-1">{caption}</p>}
        </div>
        <div className="shrink-0 w-8 h-8 rounded-lg bg-green-50 border border-green-200 flex items-center justify-center text-green-600 shadow-sm">
          <div className="scale-75">
            {icon}
          </div>
        </div>
      </div>
    </div>
  );
}

function GrowthStat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-xl sm:text-2xl font-bold text-primary-700 break-words">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}
