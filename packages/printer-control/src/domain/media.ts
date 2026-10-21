/** Managed camera and remote-file presentation. Temporary delivery credentials are not persistent DTOs. */
import type { Id, UnixMs, PrinterError, Result, ReadOptions, Capability } from './common';
import type { FileSelection, ByteRange, BinaryRead } from './files';
export type TimelapseMode = 'off' | 'traditional' | 'smooth';
export interface TimelapseSetting {
  cameraId: Id<'camera'>;
  mode: TimelapseMode;
}
export type VideoTransport = 'progressive-http' | 'hls' | 'mjpeg' | 'webrtc';
export interface VideoProfile {
  id: string;
  width: number;
  height: number;
  framesPerSecond: number | null;
}
export interface CameraMediaCapability {
  cameraId: Id<'camera'>;
  liveView: Capability<{
    transports: readonly VideoTransport[];
    profiles: readonly VideoProfile[];
    maxConcurrentViews: number | null;
  }>;
  snapshot: Capability<{
    mimeTypes: readonly ('image/jpeg' | 'image/png')[];
  }>;
}
export interface MediaClientCapabilities {
  video: readonly {
    transport: VideoTransport;
    codecIds: readonly string[];
  }[];
  imageMimeTypes: readonly string[];
  contentFormats: readonly string[];
}
export type MediaSource = {
  kind: 'camera';
  cameraId: Id<'camera'>;
  profileId?: string;
} | {
  kind: 'file-preview';
  target: FileSelection;
  previewId: Id<'preview-option'>;
};
export interface OpenMediaRequest {
  source: MediaSource;
  client: MediaClientCapabilities;
}
export interface IceServer {
  urls: readonly string[];
  username: string | null;
  credential: string | null;
}
export type VideoDelivery = {
  transport: 'progressive-http' | 'hls' | 'mjpeg';
  url: string;
} | {
  transport: 'webrtc';
  negotiationId: Id<'negotiation'>;
  offerer: 'client' | 'agent';
  iceServers: readonly IceServer[];
};
export type MediaPresentation = {
  kind: 'video';
  delivery: VideoDelivery;
  profile: VideoProfile | null;
  durationSeconds: number | null;
  seekable: boolean;
  codecId: string | null;
} | {
  kind: 'image';
  mimeType: string;
  url: string;
} | {
  kind: 'text' | 'toolpath';
  contentId: Id<'media-content'>;
  contentFormat: string;
  mimeType: string | null;
  sizeBytes: number | null;
  byteRanges: boolean;
};

/** Ephemeral delivery data, potentially containing authorization; never persist/log it. */
export interface MediaDescriptor {
  id: Id<'media-session'>;
  revision: number;
  printerSessionId: Id<'session'>;
  routeId: Id<'route'>;
  epoch: Id<'connection-epoch'>;
  source: MediaSource;
  presentation: MediaPresentation;
  expiresAtMs: UnixMs | null;
}
export type WebRtcSignal = {
  kind: 'description';
  negotiationId: Id<'negotiation'>;
  descriptionType: 'offer' | 'answer';
  sdp: string;
} | {
  kind: 'ice-candidate';
  negotiationId: Id<'negotiation'>;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
} | {
  kind: 'ice-complete';
  negotiationId: Id<'negotiation'>;
};
export interface MediaEvent {
  sequence: number;
  payload: {
    type: 'descriptor';
    descriptor: MediaDescriptor;
  } | {
    type: 'state';
    state: 'connecting' | 'ready' | 'interrupted';
  } | {
    type: 'signal';
    signal: WebRtcSignal;
  } | {
    type: 'error';
    error: PrinterError;
  } | {
    type: 'closed';
    reason: 'client' | 'parent-closed' | 'connection-reset' | 'expired' | 'error';
  };
}
export interface MediaSession {
  readonly id: Id<'media-session'>;
  /** Initial descriptor first; retain early signaling until watched, or fail explicitly. */
  watch(options?: ReadOptions): AsyncIterable<MediaEvent>;
  /** Refreshed delivery may change URLs or negotiation; inspect the returned revision. */
  renew(options?: ReadOptions): Promise<Result<MediaDescriptor>>;
  /** Reject stale negotiation IDs and non-WebRTC sessions. */
  sendSignal(signal: WebRtcSignal): Promise<Result<null>>;
  readContent(request: {
    contentId: Id<'media-content'>;
    range?: ByteRange;
  }, options?: ReadOptions): Promise<Result<BinaryRead>>;
  /** Idempotent resource release; does not stop recording or a print job. */
  close(): Promise<void>;
}
export interface CameraImage {
  cameraId: Id<'camera'>;
  mimeType: 'image/jpeg' | 'image/png';
  capturedAtMs: UnixMs | null;
  receivedAtMs: UnixMs;
  bytes: Uint8Array;
}
export interface PrinterMedia {
  open(request: OpenMediaRequest, options?: ReadOptions): Promise<Result<MediaSession>>;
  captureSnapshot(cameraId: Id<'camera'>, options?: ReadOptions): Promise<Result<CameraImage>>;
}
