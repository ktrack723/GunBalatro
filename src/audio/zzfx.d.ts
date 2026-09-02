// zzfx 는 타입 선언을 제공하지 않는다. 우리가 쓰는 표면만 선언한다.
declare module 'zzfx' {
  export const ZZFX: {
    volume: number
    sampleRate: number
    audioContext: AudioContext
    play(...parameters: number[]): AudioBufferSourceNode
    playSamples(channels: number[][], volumeScale?: number, rate?: number, pan?: number, loop?: boolean): AudioBufferSourceNode
    buildSamples(...parameters: number[]): number[]
  }
  export function zzfx(...parameters: number[]): AudioBufferSourceNode
}
