// 効果音をWeb Audioで合成（音源ファイル無し）。
// ブラウザの自動再生制限のため、最初のクリック/キー押下までは無効。

let ctx: AudioContext | null = null;
let enabled = false;
let masterGain: GainNode | null = null;

function ensure(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.4;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

export function enableSfx() {
  if (enabled) return;
  enabled = true;
  ensure();
  if (ctx && ctx.state === "suspended") ctx.resume();
}

export function setVolume(v: number) {
  if (masterGain) masterGain.gain.value = Math.max(0, Math.min(1, v));
}

function envelope(c: AudioContext, gain: GainNode, attack: number, decay: number, peak = 1) {
  const t = c.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

export function sfxHitPlayer() {
  const c = ensure(); if (!c) return;
  // ヒット: ノイズバースト + 低周波
  const noise = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate * 0.12, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  noise.buffer = buf;
  const ng = c.createGain();
  envelope(c, ng, 0.002, 0.12, 0.6);
  const filter = c.createBiquadFilter();
  filter.type = "lowpass"; filter.frequency.value = 1200;
  noise.connect(filter).connect(ng).connect(masterGain!);
  noise.start();

  const osc = c.createOscillator();
  osc.type = "square";
  osc.frequency.value = 180;
  osc.frequency.exponentialRampToValueAtTime(60, c.currentTime + 0.15);
  const og = c.createGain();
  envelope(c, og, 0.003, 0.18, 0.35);
  osc.connect(og).connect(masterGain!);
  osc.start();
  osc.stop(c.currentTime + 0.2);
}

export function sfxHitNpc() {
  const c = ensure(); if (!c) return;
  const osc = c.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 320;
  osc.frequency.exponentialRampToValueAtTime(120, c.currentTime + 0.1);
  const g = c.createGain();
  envelope(c, g, 0.002, 0.1, 0.25);
  osc.connect(g).connect(masterGain!);
  osc.start();
  osc.stop(c.currentTime + 0.12);
}

export function sfxScore() {
  const c = ensure(); if (!c) return;
  const o1 = c.createOscillator();
  o1.type = "sine"; o1.frequency.value = 660;
  o1.frequency.linearRampToValueAtTime(990, c.currentTime + 0.12);
  const g = c.createGain();
  envelope(c, g, 0.005, 0.18, 0.3);
  o1.connect(g).connect(masterGain!);
  o1.start();
  o1.stop(c.currentTime + 0.22);
}

export function sfxFootstep() {
  const c = ensure(); if (!c) return;
  const noise = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate * 0.04, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1);
  noise.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass"; filter.frequency.value = 800; filter.Q.value = 1;
  const g = c.createGain();
  envelope(c, g, 0.001, 0.04, 0.08);
  noise.connect(filter).connect(g).connect(masterGain!);
  noise.start();
}

export function sfxRoundStart() {
  const c = ensure(); if (!c) return;
  const freqs = [440, 660, 880];
  freqs.forEach((f, i) => {
    const o = c.createOscillator();
    o.type = "sine"; o.frequency.value = f;
    const g = c.createGain();
    const t0 = c.currentTime + i * 0.1;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.35, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    o.connect(g).connect(masterGain!);
    o.start(t0);
    o.stop(t0 + 0.25);
  });
}

export function sfxRoundEnd() {
  const c = ensure(); if (!c) return;
  const o = c.createOscillator();
  o.type = "sawtooth"; o.frequency.value = 220;
  o.frequency.exponentialRampToValueAtTime(110, c.currentTime + 0.5);
  const g = c.createGain();
  envelope(c, g, 0.01, 0.6, 0.3);
  o.connect(g).connect(masterGain!);
  o.start();
  o.stop(c.currentTime + 0.7);
}
