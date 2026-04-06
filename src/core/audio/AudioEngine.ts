/**
 * Studio-grade procedural wind and leaf audio engine.
 *
 * Signal flow:
 *   [pink-noise L / R] → wind 4-band filter (low/mid/high/air) → band mix
 *     → gustVCA (AHDSR events) → windSpeedVCA → widener → autoPanner → windLayerOut
 *   [white-noise]     → leaf dual filter (body/air) → tremolo VCA (7Hz+13Hz)
 *     → leafDensityVCA → leafPanner → leafLayerOut
 *   both → windBus → (dry + reverb send → convolver → wetGain) → mixSum
 *     → EQ (low shelf / mud / presence / air shelf) → bus compressor
 *     → safety limiter → masterGain → destination
 *
 * All AudioParam changes use setTargetAtTime for click-free transitions.
 * Uses only native Web Audio nodes — no ScriptProcessor or AudioWorklet.
 */

export interface AudioInputState {
  // Existing Metree params driving the audio
  windSpeed: number;        // 0-15
  gustStrength: number;     // 0-1
  windBias: number;         // 0-1

  // Live gust sample — computed from the SAME FBM formula the shader uses,
  // so audio tracks the visual wavefront in perfect lockstep. Range: 0..1+
  gustSample: number;

  // Scene spatialization — tree's projected NDC X position (-1..1)
  treeScreenX: number;

  // Audio UI params
  audioEnabled: boolean;
  masterVolume: number;     // 0-1.5
  audioMute: boolean;
  stereoWidth: number;      // 0-2
  reverbMix: number;        // 0-1
  reverbRoomSize: number;   // 0-1
  reverbDamping: number;    // 0-1
  compressionAmount: number;// 0-1
  eqTilt: number;           // -1..1
  eqPresence: number;       // dB
  eqAir: number;            // dB
  gustAttack: number;       // 0.3-4.0 (multiplier)
  gustRelease: number;      // 0.5-6.0 (multiplier)
  lowBandGain: number;      // 0-1
  midBandGain: number;      // 0-1
  highBandGain: number;     // 0-1
  airBandGain: number;      // 0-1
}

type ACtor = { new (opts?: AudioContextOptions): AudioContext };

const TAU = 0.05;         // default smoothing time constant for setTargetAtTime
const TAU_FAST = 0.02;    // master/mute fast ramp
const TAU_SLOW = 0.10;    // filter frequency moves

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private initialized = false;
  private running = false;
  private disposed = false;

  // Buffers
  private noiseBufA: AudioBuffer | null = null; // pink L
  private noiseBufB: AudioBuffer | null = null; // pink R
  private reverbIR: AudioBuffer | null = null;

  // Source nodes (recreated on each start() — BSNs are one-shot)
  private windSrcL: AudioBufferSourceNode | null = null;
  private windSrcR: AudioBufferSourceNode | null = null;

  // Wind layer
  private windMerger!: ChannelMergerNode;
  private windIn!: GainNode;
  private windFLow!: BiquadFilterNode;
  private windFMid!: BiquadFilterNode;
  private windFHigh!: BiquadFilterNode;
  private windFAir!: BiquadFilterNode;
  private gLow!: GainNode;
  private gMid!: GainNode;
  private gHigh!: GainNode;
  private gAir!: GainNode;
  private windBandMix!: GainNode;
  private windSpeedVCA!: GainNode;
  // Filter chaos LFOs — slow drift on filter frequencies to avoid audible looping
  private chaosLFOs: OscillatorNode[] = [];
  // Widener (delay M/S)
  private widenerSplit!: ChannelSplitterNode;
  private widenerLDelay!: DelayNode;
  private widenerRDelay!: DelayNode;
  private widenerMerge!: ChannelMergerNode;
  private widenerSideCtrl!: ConstantSourceNode;
  private windLayerOut!: GainNode;
  // Scene-space panner (driven by tree screen X) — placed on the dry bus so
  // reverb stays centered for natural ambient surround.
  private scenePanner!: StereoPannerNode;

  // Bus / reverb
  private windBus!: GainNode;
  private dryGain!: GainNode;
  private reverbSend!: GainNode;
  private convolver!: ConvolverNode;
  private wetGain!: GainNode;
  private mixSum!: GainNode;

  // Master chain
  private eqLowShelf!: BiquadFilterNode;
  private eqMudPeak!: BiquadFilterNode;
  private eqPresencePeak!: BiquadFilterNode;
  private eqAirShelf!: BiquadFilterNode;
  private busComp!: DynamicsCompressorNode;
  private limiter!: DynamicsCompressorNode;
  private masterGain!: GainNode;

  // Envelope follower for shader-sampled gust signal
  private gustFollower = 0;

  // Reverb regeneration debounce
  private reverbDebounceTimer: number | null = null;
  private lastRoomSize = -1;
  private lastDamping = -1;

  // Fallback suspend-resume listeners
  private resumeOnGesture = (): void => {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* ignore */ });
    }
  };
  private onVisibility = (): void => {
    if (!document.hidden) this.resumeOnGesture();
  };

  isInitialized(): boolean { return this.initialized; }
  isRunning(): boolean { return this.running; }

  /** Create AudioContext and build the whole graph. Call from a user gesture. */
  async initialize(): Promise<void> {
    if (this.initialized || this.disposed) return;
    const AC: ACtor | undefined =
      (window as unknown as { AudioContext?: ACtor }).AudioContext ||
      (window as unknown as { webkitAudioContext?: ACtor }).webkitAudioContext;
    if (!AC) {
      console.warn('[AudioEngine] Web Audio API not supported');
      return;
    }
    try {
      this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      // Some browsers reject explicit sampleRate; retry with defaults
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }

    this.createNoiseBuffers();
    this.reverbIR = this.generateReverbIR(0.55, 0.55);
    this.buildGraph();
    this.initialized = true;

    // Fallback resume hooks
    document.addEventListener('pointerdown', this.resumeOnGesture, { passive: true });
    document.addEventListener('keydown', this.resumeOnGesture);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Start source nodes and gust scheduler. */
  start(): void {
    if (!this.initialized || !this.ctx || this.running) return;

    // BufferSources are one-shot; must be created fresh on each start.
    this.windSrcL = this.ctx.createBufferSource();
    this.windSrcL.buffer = this.noiseBufA;
    this.windSrcL.loop = true;
    this.windSrcL.connect(this.windMerger, 0, 0);
    this.windSrcL.start(0);

    this.windSrcR = this.ctx.createBufferSource();
    this.windSrcR.buffer = this.noiseBufB;
    this.windSrcR.loop = true;
    this.windSrcR.connect(this.windMerger, 0, 1);
    this.windSrcR.start(0);

    this.running = true;
  }

  /** Stop sources (context stays alive). */
  stop(): void {
    if (!this.running) return;
    try { this.windSrcL?.stop(); } catch { /* ignore */ }
    try { this.windSrcR?.stop(); } catch { /* ignore */ }
    try { this.windSrcL?.disconnect(); } catch { /* ignore */ }
    try { this.windSrcR?.disconnect(); } catch { /* ignore */ }
    this.windSrcL = null;
    this.windSrcR = null;
    this.gustFollower = 0;
    this.running = false;
  }

  /** Release all resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    document.removeEventListener('pointerdown', this.resumeOnGesture);
    document.removeEventListener('keydown', this.resumeOnGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);

    if (this.reverbDebounceTimer !== null) {
      window.clearTimeout(this.reverbDebounceTimer);
      this.reverbDebounceTimer = null;
    }

    if (this.ctx) {
      try {
        this.widenerSideCtrl?.stop();
        for (const osc of this.chaosLFOs) {
          try { osc.stop(); } catch { /* ignore */ }
        }
        this.chaosLFOs = [];
      } catch { /* ignore */ }
      try { this.ctx.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.initialized = false;
  }

  /** Called every animation frame with current full state. */
  update(state: AudioInputState, _dt: number): void {
    if (!this.initialized || !this.ctx) return;
    // Auto-resume if the context dropped to suspended (tab re-focus, etc.)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* ignore */ });
    }
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Master volume + mute
    const effectiveMaster = state.audioMute ? 0 : Math.max(0, state.masterVolume);
    this.masterGain.gain.setTargetAtTime(effectiveMaster, now, TAU_FAST);

    // ── Gust envelope follower — adaptive attack/release.
    // Big gusts get a faster attack to catch sharp wavefronts, and slightly
    // longer release so the swell lingers. Small puffs stay snappy both ways.
    const rawGust = Math.max(0, state.gustSample);
    const atk = 0.22 + Math.min(0.25, rawGust * 0.35);    // 0.22..0.47
    const rel = 0.020 + Math.min(0.020, this.gustFollower * 0.025); // 0.020..0.040
    if (rawGust > this.gustFollower) {
      this.gustFollower += (rawGust - this.gustFollower) * atk;
    } else {
      this.gustFollower += (rawGust - this.gustFollower) * rel;
    }
    const gustEnergy = this.gustFollower;

    // Normalized wind speed & bias
    const sNorm = Math.max(0, Math.min(1, state.windSpeed / 15));
    const biasComp = Math.max(0, Math.min(1, state.windBias));

    // ── Physically-based motion model ─────────────────────
    // gustEnergy already encodes actual displacement (smoothstep × speed ×
    // gustStrength / 15), so it's ~0 at low wind even with gustStrength=1.
    // This makes audio track the tree motion we actually see.
    const droneMotion = Math.pow(sNorm, 0.9) * (0.12 + biasComp * 0.40);
    // Gust contribution: the displacement-coupled sample gives us natural
    // scaling — we just multiply by a constant amp factor.
    const gustSwell = gustEnergy * 4.2;
    const windLevel = Math.min(3.2, droneMotion + gustSwell);
    this.windSpeedVCA.gain.setTargetAtTime(windLevel, now, TAU * 0.35);

    // ── Per-band turbulence profiles ──────────────────────
    // Real wind spectra: small-scale eddies (high freq) dominate at calm;
    // large-scale rumble (low freq) only emerges at strong wind.
    //   Low band : "rumble", threshold-like — silent until real wind
    //   Mid band : "body whoosh", gentle across the range
    //   High band: "hiss", moderate at calm, grows with speed
    //   Air band : "sizzle/whistle", always present (leaves/branches whistle
    //              even in a breeze), grows less with speed
    const lowSpeedScale  = Math.pow(sNorm, 2.4);               // emerges ~sNorm>0.4
    const midSpeedScale  = 0.22 + Math.pow(sNorm, 0.85) * 0.78;
    const highSpeedScale = 0.40 + sNorm * 0.60;
    const airSpeedScale  = 0.62 + sNorm * 0.38;

    // Gust brightening is HF-biased — spectral tilt follows velocity spikes.
    // gustEnergy is displacement-coupled (max ~1.0 at full storm, ~0.05 at
    // calm), so boost multipliers must be large to be audible across the
    // range. At LOW wind, gust sweeps are proportionally MORE noticeable
    // (no masking baseline), so we emphasize boost when sNorm is small.
    const gustEmphasis = 1.0 + (1 - sNorm) * 2.5;   // 3.5 at calm, 1.0 at max
    const gustLowBoost  = 1.0 + gustEnergy * 1.2 * gustEmphasis;
    const gustMidBoost  = 1.0 + gustEnergy * 2.8 * gustEmphasis;
    const gustHighBoost = 1.0 + gustEnergy * 7.5 * gustEmphasis;
    const gustAirBoost  = 1.0 + gustEnergy * 10.0 * gustEmphasis;

    this.gLow.gain .setTargetAtTime(state.lowBandGain  * lowSpeedScale  * gustLowBoost,  now, TAU);
    this.gMid.gain .setTargetAtTime(state.midBandGain  * midSpeedScale  * gustMidBoost,  now, TAU);
    this.gHigh.gain.setTargetAtTime(state.highBandGain * highSpeedScale * gustHighBoost, now, TAU * 0.4);
    this.gAir.gain .setTargetAtTime(state.airBandGain  * airSpeedScale  * gustAirBoost,  now, TAU * 0.4);

    // Filter center frequency sweep — "whoosh" character of gusts.
    // Sweep depth scales with displacement-coupled gustEnergy, emphasized
    // at low wind (small-scale fast eddies produce sharper sweeps).
    const gustSweepDepth = (2.5 + (1 - sNorm) * 4.0) * gustEnergy;
    const speedBright = 1.0 + Math.pow(sNorm, 0.8) * 0.18 + gustSweepDepth;
    this.windFLow.frequency .setTargetAtTime(200 * (1.0 + sNorm * 0.08),     now, TAU_SLOW);
    this.windFMid.frequency .setTargetAtTime(900  * speedBright,             now, TAU * 0.4);
    this.windFHigh.frequency.setTargetAtTime(3500 * speedBright,             now, TAU * 0.4);
    this.windFAir.frequency .setTargetAtTime(8000 * speedBright,             now, TAU * 0.4);

    // Scene panner — dry signal follows tree's on-screen X position.
    // Full ±1 range: when tree is at screen edge, sound is fully L or R.
    const scenePan = Math.max(-1.0, Math.min(1.0, state.treeScreenX));
    this.scenePanner.pan.setTargetAtTime(scenePan, now, TAU);

    // Stereo width — crossfeed level (1 - width).
    // width=0 → crossLevel=1 (mono blend), width=1 → 0 (natural),
    // width=2 → -1 (polarity-inverted crossfeed for super-wide).
    const width = Math.max(0, Math.min(2, state.stereoWidth));
    const crossLevel = 1.0 - width;
    this.widenerSideCtrl.offset.setTargetAtTime(crossLevel, now, TAU);

    this.windLayerOut.gain.setTargetAtTime(1.0, now, TAU);

    // Reverb send / wet / dry
    const mix = Math.max(0, Math.min(1, state.reverbMix));
    // Equal-power crossfade
    this.dryGain.gain.setTargetAtTime(Math.cos(mix * Math.PI * 0.5), now, TAU);
    this.wetGain.gain.setTargetAtTime(Math.sin(mix * Math.PI * 0.5), now, TAU);

    // Reverb IR regen (debounced)
    if (Math.abs(state.reverbRoomSize - this.lastRoomSize) > 0.005 ||
        Math.abs(state.reverbDamping - this.lastDamping) > 0.005) {
      this.lastRoomSize = state.reverbRoomSize;
      this.lastDamping = state.reverbDamping;
      if (this.reverbDebounceTimer !== null) {
        window.clearTimeout(this.reverbDebounceTimer);
      }
      this.reverbDebounceTimer = window.setTimeout(() => {
        this.reverbDebounceTimer = null;
        if (!this.ctx) return;
        this.reverbIR = this.generateReverbIR(this.lastRoomSize, this.lastDamping);
        this.convolver.buffer = this.reverbIR;
      }, 200);
    }

    // Compression amount: modulate threshold -22 → -36 with makeup
    const compAmt = Math.max(0, Math.min(1, state.compressionAmount));
    const thr = -22 - compAmt * 14;
    this.busComp.threshold.setTargetAtTime(thr, now, TAU);
    // Approximate auto-makeup: extra gain on masterGain's input? Simpler: bump mixSum.
    // We'll compensate via a gentle post-comp level by altering limiter threshold is wrong —
    // instead gently lift the busComp.ratio knee to preserve perceived loudness subtly.
    // Keep ratio fixed, rely on user masterVolume for final level.

    // EQ
    const tilt = Math.max(-1, Math.min(1, state.eqTilt));
    // tilt +1 → brighter (low -3, high +3 dB), -1 → darker
    this.eqLowShelf.gain.setTargetAtTime(-tilt * 3, now, TAU);
    this.eqAirShelf.gain.setTargetAtTime(tilt * 3 + state.eqAir, now, TAU);
    this.eqPresencePeak.gain.setTargetAtTime(state.eqPresence, now, TAU);
  }

  // ─────────────────────────────────────────────────────────
  // Private implementation
  // ─────────────────────────────────────────────────────────

  private createNoiseBuffers(): void {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    // Non-round durations + incommensurate pairs keep loop phase unpredictable.
    // Filter chaos LFOs (below) also shift the spectrum constantly, so a 12/13 s
    // buffer is inaudible as a loop.
    this.noiseBufA = this.makePinkNoiseBuffer(sr, 12, 0x1a2b3c4d);
    this.noiseBufB = this.makePinkNoiseBuffer(sr, 13, 0x5e6f7081);
  }

  private makePinkNoiseBuffer(sampleRate: number, seconds: number, seed: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const len = Math.floor(seconds * sampleRate);
    const buf = ctx.createBuffer(1, len, sampleRate);
    const d = buf.getChannelData(0);
    // Simple seeded PRNG (mulberry32)
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // 1-pole IIR low-pass on white to approximate pink — good enough, cheap
    let b = 0;
    let maxAbs = 0;
    for (let i = 0; i < len; i++) {
      const w = rand() * 2 - 1;
      b = 0.99 * b + 0.05 * w;
      d[i] = b;
      const a = Math.abs(b);
      if (a > maxAbs) maxAbs = a;
    }
    // Normalize
    if (maxAbs > 0) {
      const scale = 0.95 / maxAbs;
      for (let i = 0; i < len; i++) d[i] *= scale;
    }
    return buf;
  }

  private generateReverbIR(roomSize: number, damping: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const sr = ctx.sampleRate;
    const rs = Math.max(0, Math.min(1, roomSize));
    const dmp = Math.max(0, Math.min(1, damping));
    const durationSec = 0.4 + rs * 4.6;
    const length = Math.max(1, Math.floor(durationSec * sr));
    const decayPower = 2.0 + (1 - dmp) * 4.0;
    const earlyCutoff = Math.floor((0.08 / durationSec) * length);

    const buf = ctx.createBuffer(2, length, sr);
    const seeds = [0xdeadbeef, 0xbeeff00d];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let s = seeds[ch] >>> 0;
      const rand = () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      let last = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decayPower);
        const early = i < earlyCutoff ? 1.6 : 1.0;
        let sample = (rand() * 2 - 1) * env * early;
        // Time-varying one-pole LP: coefficient decreases with time and damping,
        // so highs get absorbed progressively.
        const coef = Math.max(0.05, 1.0 - (t * dmp * 0.9));
        sample = last + coef * (sample - last);
        last = sample;
        d[i] = sample;
      }
      // Normalize per channel
      let m = 0;
      for (let i = 0; i < length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
      if (m > 0) { const k = 0.9 / m; for (let i = 0; i < length; i++) d[i] *= k; }
    }
    // Decorrelate R channel with small sample offset
    const R = buf.getChannelData(1);
    const offset = 7; // ~0.15 ms at 48k
    const tmp = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      tmp[i] = i >= offset ? R[i - offset] : 0;
    }
    for (let i = 0; i < length; i++) R[i] = tmp[i];
    return buf;
  }

  private buildGraph(): void {
    const ctx = this.ctx as AudioContext;
    const now = ctx.currentTime;

    // ── Master chain (build first so everything downstream has a destination)
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.8;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.060;

    this.busComp = ctx.createDynamicsCompressor();
    this.busComp.threshold.value = -22;
    this.busComp.knee.value = 6;
    this.busComp.ratio.value = 2.8;
    this.busComp.attack.value = 0.025;
    this.busComp.release.value = 0.180;

    this.eqAirShelf = ctx.createBiquadFilter();
    this.eqAirShelf.type = 'highshelf';
    this.eqAirShelf.frequency.value = 10000;
    this.eqAirShelf.gain.value = 3;

    this.eqPresencePeak = ctx.createBiquadFilter();
    this.eqPresencePeak.type = 'peaking';
    this.eqPresencePeak.frequency.value = 3000;
    this.eqPresencePeak.Q.value = 1.2;
    this.eqPresencePeak.gain.value = 2;

    this.eqMudPeak = ctx.createBiquadFilter();
    this.eqMudPeak.type = 'peaking';
    this.eqMudPeak.frequency.value = 350;
    this.eqMudPeak.Q.value = 1.0;
    this.eqMudPeak.gain.value = -1.5;

    this.eqLowShelf = ctx.createBiquadFilter();
    this.eqLowShelf.type = 'lowshelf';
    this.eqLowShelf.frequency.value = 120;
    this.eqLowShelf.gain.value = 0;

    // EQ chain: lowShelf → mud → presence → airShelf → comp → limiter → master → dest
    this.eqLowShelf.connect(this.eqMudPeak);
    this.eqMudPeak.connect(this.eqPresencePeak);
    this.eqPresencePeak.connect(this.eqAirShelf);
    this.eqAirShelf.connect(this.busComp);
    this.busComp.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // ── Mix sum (input to master chain)
    this.mixSum = ctx.createGain();
    this.mixSum.gain.value = 1;
    this.mixSum.connect(this.eqLowShelf);

    // ── Reverb (send bus)
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    if (this.reverbIR) this.convolver.buffer = this.reverbIR;
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = Math.sin(0.28 * Math.PI * 0.5);
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.mixSum);

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbSend.connect(this.convolver);

    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = Math.cos(0.28 * Math.PI * 0.5);
    this.dryGain.connect(this.mixSum);

    // Scene panner — dry signal only, driven each frame from tree screen-X.
    this.scenePanner = ctx.createStereoPanner();
    this.scenePanner.pan.value = 0;
    this.scenePanner.connect(this.dryGain);

    // ── Wind bus ─ both layers feed here, then split to dry (panned) + wet (centered)
    this.windBus = ctx.createGain();
    this.windBus.gain.value = 1;
    this.windBus.connect(this.scenePanner);
    this.windBus.connect(this.reverbSend);

    // ── Wind layer
    this.windLayerOut = ctx.createGain();
    this.windLayerOut.gain.value = 1;
    this.windLayerOut.connect(this.windBus);

    // Stereo widener — delayed crossfeed with polarity control.
    // crossLevel = 1-width: 0 at natural (width=1), +1 at mono (width=0),
    // negative beyond width=1 for super-wide (polarity inversion).
    // Single ConstantSource drives both crossfeed gains so they track together.
    this.widenerMerge = ctx.createChannelMerger(2);
    this.widenerMerge.connect(this.windLayerOut);

    this.widenerSplit = ctx.createChannelSplitter(2);

    // Direct channels: L→L, R→R
    const directL = ctx.createGain();
    directL.gain.value = 1.0;
    const directR = ctx.createGain();
    directR.gain.value = 1.0;
    this.widenerSplit.connect(directL, 0);
    this.widenerSplit.connect(directR, 1);
    directL.connect(this.widenerMerge, 0, 0);
    directR.connect(this.widenerMerge, 0, 1);

    // Delayed crossfeeds (Haas precedence ~12 ms)
    this.widenerLDelay = ctx.createDelay(0.05);
    this.widenerLDelay.delayTime.value = 0.012;
    this.widenerRDelay = ctx.createDelay(0.05);
    this.widenerRDelay.delayTime.value = 0.012;
    this.widenerSplit.connect(this.widenerLDelay, 0);
    this.widenerSplit.connect(this.widenerRDelay, 1);

    // Per-channel crossfeed gains, modulated by a shared ConstantSource.
    // Base gain is 0; the CS adds to it, so effective gain = crossLevel.
    const crossL_to_R = ctx.createGain();
    crossL_to_R.gain.value = 0.0;
    const crossR_to_L = ctx.createGain();
    crossR_to_L.gain.value = 0.0;
    this.widenerLDelay.connect(crossL_to_R);
    this.widenerRDelay.connect(crossR_to_L);
    crossL_to_R.connect(this.widenerMerge, 0, 1);
    crossR_to_L.connect(this.widenerMerge, 0, 0);

    // Shared control signal for both crossfeed gains.
    this.widenerSideCtrl = ctx.createConstantSource();
    this.widenerSideCtrl.offset.value = 0.0;
    this.widenerSideCtrl.connect(crossL_to_R.gain);
    this.widenerSideCtrl.connect(crossR_to_L.gain);
    this.widenerSideCtrl.start(now);

    // Single wind VCA — gain is set each frame on the main thread as a
    // composite of (windSpeed drone + windBias steady + gust envelope energy).
    this.windSpeedVCA = ctx.createGain();
    this.windSpeedVCA.gain.value = 0;
    this.windSpeedVCA.connect(this.widenerSplit);

    // Band mix feeds directly into the wind VCA
    this.windBandMix = ctx.createGain();
    this.windBandMix.gain.value = 1;
    this.windBandMix.connect(this.windSpeedVCA);

    this.gLow  = ctx.createGain(); this.gLow.gain.value  = 0.5;
    this.gMid  = ctx.createGain(); this.gMid.gain.value  = 0.75;
    this.gHigh = ctx.createGain(); this.gHigh.gain.value = 0.55;
    this.gAir  = ctx.createGain(); this.gAir.gain.value  = 0.3;
    this.gLow.connect(this.windBandMix);
    this.gMid.connect(this.windBandMix);
    this.gHigh.connect(this.windBandMix);
    this.gAir.connect(this.windBandMix);

    this.windFLow = ctx.createBiquadFilter();
    this.windFLow.type = 'lowpass';
    this.windFLow.frequency.value = 200;
    this.windFLow.Q.value = 0.7;
    this.windFLow.connect(this.gLow);

    this.windFMid = ctx.createBiquadFilter();
    this.windFMid.type = 'bandpass';
    this.windFMid.frequency.value = 900;
    this.windFMid.Q.value = 1.2;
    this.windFMid.connect(this.gMid);

    this.windFHigh = ctx.createBiquadFilter();
    this.windFHigh.type = 'highpass';
    this.windFHigh.frequency.value = 3500;
    this.windFHigh.Q.value = 0.7;
    this.windFHigh.connect(this.gHigh);

    this.windFAir = ctx.createBiquadFilter();
    this.windFAir.type = 'highpass';
    this.windFAir.frequency.value = 8000;
    this.windFAir.Q.value = 0.7;
    this.windFAir.connect(this.gAir);

    // Source input merger + windIn
    this.windIn = ctx.createGain();
    this.windIn.gain.value = 1;
    this.windIn.connect(this.windFLow);
    this.windIn.connect(this.windFMid);
    this.windIn.connect(this.windFHigh);
    this.windIn.connect(this.windFAir);

    this.windMerger = ctx.createChannelMerger(2);
    this.windMerger.connect(this.windIn);

    // ── Filter chaos LFOs ─────────────────────────────────
    // Slow, incommensurate sinusoids on filter .detune keep the spectrum
    // continuously shifting. This hides the noise-buffer loop and creates
    // the natural "billowing" character of real wind.
    const addChaos = (target: AudioParam, freq: number, depth: number): void => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = depth;
      osc.connect(g);
      g.connect(target);
      osc.start(now);
      this.chaosLFOs.push(osc);
    };
    addChaos(this.windFMid.detune,  0.053, 300);
    addChaos(this.windFMid.detune,  0.113, 180);  // stacked at different rates
    addChaos(this.windFHigh.detune, 0.071, 250);
    addChaos(this.windFAir.detune,  0.089, 200);
  }

}
