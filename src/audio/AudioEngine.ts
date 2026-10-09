export type AudioEngineStatus = 'idle' | 'ready' | 'unsupported' | 'closed';

/** Lifecycle boundary for a future Web Audio/Tone.js scheduler. */
export interface AudioEngine {
  readonly status: AudioEngineStatus;
  initialize(): Promise<AudioEngineStatus>;
  dispose(): Promise<void>;
}

export class BrowserAudioEngine implements AudioEngine {
  private context: AudioContext | null = null;

  get status(): AudioEngineStatus {
    if (!this.context) return 'idle';
    if (this.context.state === 'closed') return 'closed';
    return this.context.state === 'running' ? 'ready' : 'idle';
  }

  /** Call only from an explicit user gesture so browser autoplay policies are respected. */
  async initialize(): Promise<AudioEngineStatus> {
    if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') {
      return 'unsupported';
    }

    try {
      if (!this.context || this.context.state === 'closed') {
        this.context = new window.AudioContext({ latencyHint: 'interactive' });
      }
      if (this.context.state === 'suspended') await this.context.resume();
      if (this.context.state === 'closed') return 'closed';
      if (this.context.state !== 'running') throw new Error('The browser audio context did not enter the running state.');
      return 'ready';
    } catch (error) {
      throw new Error('The browser could not start its audio context.', { cause: error });
    }
  }

  async dispose(): Promise<void> {
    if (this.context && this.context.state !== 'closed') {
      await this.context.close();
    }
    this.context = null;
  }
}
