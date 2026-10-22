/** Managed camera and remote-file presentation. Temporary delivery credentials are not persistent DTOs. */
import type { Id, Revision, UnixMs, PrinterError, Result, ReadOptions, Capability, PrinterTarget, TargetRequest, NonEmptyReadonlyArray } from './common';
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
    transports: NonEmptyReadonlyArray<VideoTransport>;
    /** Empty means only adapter-selected delivery; omit profileId in the request. */
    profiles: readonly VideoProfile[];
    /** Unknown viewer limit; null does not mean unlimited viewers. */
    maxConcurrentViews: number | null;
  }>;
  snapshot: Capability<{
    mimeTypes: NonEmptyReadonlyArray<'image/jpeg' | 'image/png'>;
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
  /** From files.listPreviews; validate against this file, without caller-session state. */
  previewId: Id<'preview-option'>;
};
export interface OpenMediaRequest {
  target: TargetRequest;
  requestId: Id<'request'>;
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
  ref: MediaRef;
  /** Resource operations retain this configuration; they never retarget after an edit. */
  configurationRevision: Revision;
  revision: number;
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
    reason: 'client' | 'source-unavailable' | 'expired' | 'error';
  };
}
/** Explicit delivery resource, not a printer-control session or a stateful client object. */
export interface MediaRef extends PrinterTarget {
  id: Id<'media'>;
}
export interface CameraImage {
  cameraId: Id<'camera'>;
  mimeType: 'image/jpeg' | 'image/png';
  capturedAtMs: UnixMs | null;
  receivedAtMs: UnixMs;
  bytes: Uint8Array;
}
export interface PrinterMedia {
  /** Same request ID must not allocate duplicate viewers within the advertised retention lifetime. */
  open(request: OpenMediaRequest, options?: ReadOptions): Promise<Result<MediaDescriptor>>;
  /** Initial descriptor first; retain early signaling until watched, or report a gap. */
  watch(ref: MediaRef, options?: ReadOptions): AsyncIterable<MediaEvent>;
  /** Delivery may change URLs/negotiation; inspect the returned revision. */
  renew(ref: MediaRef, options?: ReadOptions): Promise<Result<MediaDescriptor>>;
  /** Reject stale negotiation IDs and non-WebRTC resources. */
  sendSignal(ref: MediaRef, signal: WebRtcSignal): Promise<Result<null>>;
  readContent(request: {
    media: MediaRef;
    contentId: Id<'media-content'>;
    range?: ByteRange;
  }, options?: ReadOptions): Promise<Result<BinaryRead>>;
  /** Idempotent resource release; does not stop recording or a print job. */
  close(ref: MediaRef): Promise<Result<null>>;
  captureSnapshot(target: PrinterTarget, cameraId: Id<'camera'>, options?: ReadOptions): Promise<Result<CameraImage>>;
}
