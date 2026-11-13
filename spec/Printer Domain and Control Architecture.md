# Printer Domain and Control Architecture

**Updated:** 2026-11-07

**Status:** Explicit requirements and selected architecture direction recorded;
TypeScript domain contracts and the existing Moonraker subset are implemented.
Device Web entry and Send use the stateless service in both hosts. Electron
Bambu integration follows section 2.1; section 2.2 distinguishes delivered
foundations, account flow, Cloud device enumeration and LAN access. LAN
real-device qualification is limited to explicitly recorded development-host
cases; broader qualification does not block packaging work.
Section 2.3 records the accepted Bambu monitoring/control scope and interactions,
with implementation authorized in independently verified increments and physical
qualification deferred until software verification is complete. The gateway remains deferred.
Interface availability alone does not establish device support or runtime delivery.
Section 2.4 records the selected local-artifact print-submission direction;
its product decisions are accepted, with explicit implementation gates and
deferred scope. That design record does not authorize implementation.
Section 2.5 records the delivered Snapmaker agent and its separate software
acceptance and physical qualification boundaries, including non-printing U1 LAN
acceptance and one completed single-head PLA print. Multi-head printing and
shared-heater qualification remain pending.

**Scope:** The shared printer domain: discovery, identity, hardware properties,
capabilities, controls, material systems, read-only sensors, cameras, remote
files, native Web interfaces, firmware observations and synchronization across
Web, Electron and future connection services.

## 1. Authority and explicit user requirements

This is the long-lived architecture specification for the printer domain,
alongside the other major specifications in this directory. It records design
constraints rather than TypeScript declarations, transport schemas or an
implementation task list. The user-selected direction is **option B**: a shared
TypeScript domain contract with protocol-specific agents behind it, allowing
execution in a suitable browser, desktop or remote service host.

The left column below records explicit user requests. The right column explains
their intended coverage; it does not make a particular interface decomposition
or implementation technique an additional user mandate.

| Explicit requirement | Design coverage |
| --- | --- |
| Abstract printer properties and capabilities before implementing agents | Hardware description, supported functions and current state are separate concepts. |
| Supported capabilities must supply request-construction information | The complete constraint description is never null; only specifically unknown limit fields may be null. |
| Abstract the various printer control interfaces | Shared features use a vendor-independent domain boundary. |
| Provide available-printer listing and discovery | Saved printers, discovery candidates and currently reachable routes are distinguishable. |
| Include capabilities known before device access in discovery/enumeration | Publish normal capabilities from provider/type/configuration and retained observations without inventing resource constraints. |
| All public APIs are stateless | Each request identifies its target or resource; no connection, initialization call, client session or prior capability query is required. |
| Manually add printer type and IP/address, and persist locally | Saving, enumeration and local description do not initiate device access. Request-based printer startup remains passive; the later Bambu plugin-lifecycle decision in section 2.1 allows Orca-compatible startup networking. |
| Preserve request-driven Moonraker use | Selecting the printer can immediately open its configured native Web interface; uploads execute on demand without ongoing observation. |
| Support manually triggered material synchronization on specific Klipper types, such as Snapmaker U1 | Declare this type-specific capability locally; read inventory only on explicit sync, with no startup fetch or background polling. |
| Include basic printer controls and AMS-like controls | Model ordinary printers and automatic material systems without making one manufacturer's AMS layout universal. |
| Display print status directly from agent observations | Name, phase and progress do not require a device job ID, a Neo submission record or correlation between them. |
| Ordinary print controls do not depend on job IDs | Pause, resume and cancel act on the printer's current print at execution time. |
| Hide special-action protocol details inside agent-issued opaque action references | Callers pass references unchanged; native job IDs, warning context and protocol parameters remain agent-owned, without a caller session. |
| Synchronize printer information and consumables | Observe device state and material inventory, with an explicit boundary around project changes. |
| Retain the source configuration revision in material import proposals | Copy it from the source snapshot and reject application after that route's configuration changes. |
| Include cameras | Model live viewing and camera-related capabilities, not just a stored camera URL. |
| Offer an optional native Web interface | Describe support independently of Neo control support, and resolve its entry without requiring a control session. |
| Derive Monitor, file browser, warnings and Firmware visibility from available functions | Keep page eligibility in the application, separate from current availability and content counts. |
| Firmware information can be read without upgrade support | Keep version observations distinct from future update checking or installation. |
| Preview remote files, including timelapses and uploaded G-code | Treat stored media and printable files as first-class resources with appropriate preview types. |
| Download, delete and reprint remote files | Define independent operations and their availability; reprinting starts an existing remote printable file. |
| Support temperature probes without temperature control, plus other sensors such as door switches | Provide a generic read-only sensor collection with data that varies and can expand by sensor type. |
| Integrate the design and check duplicates, omissions and responsibility boundaries | Maintain one coherent domain model and retain examples for different printer configurations. |
| Defer concrete agents and the gateway during interface design | Existing Moonraker behavior is delivered. Bambu implementation follows the accepted sequence in section 2.2; the gateway remains deferred. |
| Use open-bamboo-networking for initial Bambu login and printer discovery | Select the Electron native-addon approach; no Web execution in this phase. |
| Keep account methods and modeling outside printer-control | The shared application architecture owns a separate common provider/account boundary; a provider offering account and printer functionality implements both interfaces. |
| Support explicit overwrite as a normal upload capability | Overwrite is a first-class collision choice, advertised per destination and explicitly selected in upload requests. |
| Record constraints rather than concrete TypeScript interfaces | Keep interface source code and exhaustive API signatures out of this specification. |

The nozzle-material question was answered by distinguishing nozzle construction
material from loaded filament. Preserve that distinction in the design; the
suggested property name is not an independently approved interface requirement.
The requested modeling examples are retained in section 11. Neither those
examples nor the feature lists below are an exhaustive ceiling on printer
support: the original functional request was explicitly non-exhaustive.

### 1.1 Decision status and interpretation

The explicit requests above and selection of option B are established user
decisions. Stateless access and locally known capabilities in sections 3–3.1,
and the native Web interface and page-eligibility rules in sections 4.1–4.3 are accepted
user decisions; their precise UI layout remains open.
Existing requirements inherited from linked repository specifications
remain authoritative. The rest of this document records the proposed domain
semantics and design constraints from the discussion, not blanket user approval
of every previously suggested interface detail. Where a concrete mechanism is
described, it is a candidate unless its authority is explicitly identified.
Changing such a mechanism must preserve the applicable user requirements and
existing repository contracts; it does not require treating the earlier
TypeScript sketch as a frozen schema.

In particular, the following choices remain reviewable:

| Area | Current proposal, not a fixed implementation requirement |
| --- | --- |
| Initial technology coverage | Non-mixing FDM as the first modeling focus; other technologies are not a user-imposed permanent exclusion. |
| Entity layout and command definitions | Separate resource records, a command-specification map and derived request/capability types; exact field layout and code generation remain open. |
| Synchronization | Topic-scoped snapshots, replacements, opaque feed cursors and resource revisions; equivalent coherent synchronization is possible without client sessions. |
| Operation tracking | Service-scoped tracking and request lookup; ownership, storage and retention are not prescribed. |
| Sensor representation | Typed readings, common sensor storage and references from heaters/material units; extension registration and lookup/indexing are open. |
| Media | Explicit media resources for live and stored content, and WebRTC signaling when selected; concrete transports and resource reuse rules are open. |
| Remote-file identity | The selected Storage design retains printer/route/configuration-scoped references and removes file-content version checks and strict/best-effort modes; the TypeScript contracts now use direct scoped file references without content-version modes. |
| Transfers | Paged listings, streamed reads, invalidation notifications and reject/rename/overwrite upload policies; no exact wire API or universal provider support is assumed. |
| Credentials | Opaque credential references; Bambu session storage/refresh is delegated to the black-box plugin in section 2.1. Other credential migration and host storage remain open. |
| Project material import | The accepted [Prepare synchronization design](Printer%20Console%20and%20Control%20Integration.md#prepare-printer-and-filament-synchronization) provides implemented modal material mapping/rebuild and atomic native application; physical qualification remains separate. |

A proposed abstraction is not evidence that a particular printer or host
already implements it. This classification applies to sections 2–11, including
their suggested acceptance scenarios. Including a feature in the domain does
not require every printer or provider to support it; capability reporting must
preserve that distinction.

### 1.2 Current interface boundary

The [platform contract root](../packages/platform-contract/src/index.ts)
exports the public printer interfaces and DTOs, organized internally in the
[printer contracts](../packages/platform-contract/src/printer/index.ts). It defines the current
contract for printer resources, materials, extensible sensors, controls,
capabilities, files, media, discovery, manual configuration and native Web entry
resolution. All public operations are independently addressed. Discovery and
saved-route enumeration use the same capability model as local description;
type-known support does not require a probe. Observations explicitly distinguish
cached access from a one-shot device read, including materials and firmware.
The source is authoritative
for current field shapes; this specification records their purpose and limits.
The [compile-only consumers](../packages/platform-contract/typechecks/domain.ts)
exercise typed extensions, command/result correlations and
representative printer shapes without implementing an agent.

The interface selects typed topic reads, replacement events with opaque cursors,
a typed command map, explicit media resource references and scoped file references.
The Storage contract uses direct remote-file references without file-content
consistency modes. Current types are not evidence that the user mandated a
particular transport or permanent schema.
Future refinements update the single contract and its consumers together.
No gateway wire format or credential persistence migration is defined. The bounded
Moonraker runtime migration is described below.

`@orca/printer-control` contains implementations and exports the [Moonraker service factory](../packages/printer-control/src/service.ts).
It depends on `@orca/platform-contract` and implements the domain service using
host-injected configuration and HTTP transport. Persisted printer document types,
HTTP/WebSocket transport seams, download/transfer DTOs and mDNS contracts also
belong to the platform contract root. Configuration validation, vendor protocols
and task executors remain in `printer-control`. The contract package, including
its tests and fixtures, must not depend on this implementation package; the import
guard enforces that direction. There is no separate network-discovery package or
printer contract subpath. Both hosts provide this service through the platform contract;
application code uses the domain API instead of the retired driver and Send
service. There is one current control contract, without a compatibility alias.
Project material import remains an application-owned workflow; its proposal
type does not authorize telemetry to mutate a native project.

### 1.3 Delivered Moonraker subset

This migration preserves existing functions: local manual configuration and Web
console entry, an explicit server-information read, a one-shot status read,
G-code upload and print start/pause/resume/cancel. It adds no discovery, polling,
material synchronization, camera, remote-file browsing/download/delete/preview,
or new device pages. These capabilities report unsupported. Firmware and status
observations are on-demand only; watch rejects rather than starting polling.
Saving, enumeration, description, cached reads and Web entry resolution perform
no network I/O. Startup and selection never establish a printer connection.

Configuration remains the existing version-1 host repository, including its API
key storage and console URL fallback. The domain projects opaque credential
references; it never includes keys in descriptions, snapshots, operations or
errors. Explicit configuration-form reads can return credentials for editing.
Agents advertise manual configuration support and its host, input fields,
labels, required flags, defaults and optional model selection through the local
type catalogue. The shared form reads and saves through the agent configuration
API. Agents validate and persist locally, serialize repository mutations, check
route revisions on edits and recognize repeated save requests. The HTTP agents
continue using the version-1 host repository, including stable printer IDs,
model associations and independent print preferences. Switching between the two
HTTP adapters preserves the printer ID. Electron retains its existing built-in
console authentication script. Route changes invalidate cached readings
and change an opaque configuration revision. In-flight operations retain their
submission configuration; later actions on old file references reject as stale.

Each resolved request binds the configuration contents (including address and
credentials), its revision and its generation's observation cache as one
snapshot. Enumeration, descriptions, configuration-edit results, operations and
file references must derive from that same binding, never combine a previously
read document with a revision fetched later from shared state. Replacing or
removing a configuration does not rewrite snapshots retained by in-flight work.
Late device responses may complete their original reads, but cannot populate a
new configuration generation's cache. An upload to an old address therefore
returns an old-revision file reference; starting it against a changed route
rejects as stale, even when the caller omitted an expected revision at upload.

Facades sharing a host repository serialize their local configuration reads,
version registration and read-modify-save operations. A delayed earlier read
must not replace a newer registered generation. Successful edits return the
snapshot they saved; failed reads or saves must not block later requests or
publish an unsaved generation. Upload streaming, printer HTTP and operation
observation run outside this local coordination. Direct host settings edits
remain supported and are observed on subsequent repository reads; this does
not introduce a cross-process repository transaction or a caller session.

Upload advertises the default G-code destination with explicit overwrite.
Send selects that advertised policy to retain the previous same-name behavior.
The existing multipart host transports still buffer a complete file; the
adapter checks the declared length and enforces its advertised 2,147,483,647-byte
buffer limit before network dispatch. It does not claim chunked network upload.
Transfer totals are transport bytes, including multipart overhead where reported;
a null total means unknown, not the declared file length. Completion requires
the device response and returns the actual remote path as a route-bound file
reference. Start consumes that reference directly, retaining device/configuration
validation without file-content version comparison. No listing or connection
preflight is required.

Response decoding follows each Moonraker endpoint's contract. The HTTP-only
[file upload endpoint](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/#file-upload)
returns HTTP 201 with a top-level uploaded item, including for overwrite;
ordinary queries and command acknowledgements retain their result envelope.
Upload completion requires a valid item in the requested `gcodes` root and its
root-relative file path. That exact path identifies the returned file and any
subsequent print start. The adapter must not guess a path from the submitted name
or alternate response fields. An interrupted or malformed successful response,
including an unusable file location, leaves the upload outcome unknown and does
not trigger an automatic retry or print start.

Operations are independent resources retained by the host service authority for
its lifetime, shared by facades using that authority's configuration repository.
A request ID deduplicates matching submissions within that lifetime; reuse with
different parameters rejects. Tracking and cancellation use explicit resource
references, never a prior observer or client session. Aborting an observer does
not cancel a physical operation; uploads have an explicit cancellation request.
Cancellation can leave remote bytes. Records and deduplication are not durable
across host restart, and unknown lookup results do not establish non-execution.

Successful command HTTP responses with the documented
[Moonraker acknowledgement](https://moonraker.readthedocs.io/en/latest/external_api/printer/#start-a-print-job)
produce an acknowledgement, not a fabricated
physical-completion result or job ID. Interrupted or malformed mutation responses
remain outcome-unknown. The Send workflow retains start-only retry after a
definite failure; an uncertain outcome requires checking the printer instead of
blindly retrying. No failover or automatic resend is performed.

The status observation maps the existing one-shot printer-object response directly
into independent phase, name and progress readings, without requesting history.
Printing, paused, completed, cancelled, failed and idle states are representable;
an unknown phase does not discard a known name or progress. Missing or invalid
progress stays unknown, including at completion; completion does not fabricate
100 percent. Idle explicitly clears the name and progress from the preceding
print. Remaining time stays unknown in this adapter. Prints initiated outside
Neo are displayed by the same path. A failed refresh leaves prior cached data
stale; it does not start background recovery.

Pause/resume/cancel send the existing PAUSE, RESUME and CANCEL_PRINT commands
with no job selector or status/history preflight. They operate on the current
print when the printer executes the command, not a previously observed print.
Configuration and request validation still apply. Evaluation is advisory and
performs no printer traffic; device acknowledgement/rejection comes from the
submitted command. No ongoing connection or subscription is retained.
Moonraker advertises special actions as unsupported and reports an empty status
action collection; no vendor action executor is introduced by this migration.

The [shared application architecture](Web-Electron%20Shared%20Application%20Architecture.md)
remains the application-wide authority. [Printer Console and Control Integration](Printer%20Console%20and%20Control%20Integration.md)
owns existing console and Send/Send & Print interaction. This document owns the
domain beneath those and richer device features, preserving selection and
explicit cancellation while distinguishing definite failure from unknown outcome. [Multi-Filament Support](Multi-Filament%20Support.md)
owns the project's native material rack. [Grand Plan](Grand%20Plan.md) remains
the only delivery roadmap.

### 1.4 Agent compatibility limits

A fixed host budget is not a printer capability. Shared contracts and feature UI
must distinguish device/protocol constraints, adapter feature coverage, resource
retention/scheduling, and content rejection introduced by Neo. In particular,
removing a transport budget does not establish that its downstream parser, IPC
validator or renderer accepts the same resource. Record every enforced layer.

The source audit covers the shared printer/service-provider contracts, Moonraker
HTTP adapter and both host transports, Bambu native/plugin wrappers, utility
provider, renderer/preload/main IPC, and shared media/object consumers. The
reference is the checked-in Orca source; plugin-internal or firmware limits cannot
be inferred from the public wrapper. Web has the Moonraker implementation; a
Bambu browser/gateway agent remains deferred.

Both CTRL purposes now use pull backpressure rather than receive-queue overflow
failure. Storage subfiles and current-project resources add no file-byte,
packet-byte or fragment-count budget; current-project response headers and
parameter metadata likewise have no fixed byte budget. Length/offset consistency,
JSON parsing, result handling, ownership/context checks and final project-resource
MD5 remain. Connection/request deadlines and outgoing admission remain separate
host policies. Orca's reference is
[`PrinterFileSystem::DownloadRamFile` and response dispatch](../packages/slicer-wasm/cpp/src/slic3r/GUI/Printer/PrinterFileSystem.cpp).
Native fixture regression covers 17 MiB metadata/images, more than 4096 fragments,
large CTRL JSON/parameter metadata, slow-consumer backpressure and malformed
content/integrity failures. This does not qualify large resources on hardware.

The following remaining application thresholds are audit findings, not new
approved device limits or claims that they have been removed:

| Owner | Remaining threshold and effect | Source/reference assessment |
| --- | --- | --- |
| [Current-task preview](../apps/desktop/src/utility/bambu/preview.ts) | Subtask JSON above 2 MiB or image content above 4 MiB is rejected. | Neo content budgets; the Orca current-task preview path does not establish these thresholds as printer limits. |
| [Object catalogue and map](../apps/desktop/src/utility/bambu/objectSkipping.ts), [shared picker](../packages/slicer-app/src/components/device/SkipObjects.tsx), [project resource selector](../packages/bambu-native/src/control.ts) | XML above 2 MiB, nesting above 64, names longer than 4096 characters or more than 4096 labels and picking images above 2048 pixels are rejected; the resource selector accepts only positive plate indices of at most three digits. | Additional Neo parser/selector/image thresholds. Orca streams XML in `ModelSettingHelper::Parse` and constructs `pick_<plate>.png` from the plate index. Removing reader byte limits alone does not remove these downstream restrictions. |
| [Storage queries](../packages/bambu-native/src/storageQueries.ts), [channel](../packages/bambu-native/src/storageChannel.ts), [listing snapshots](../apps/desktop/src/utility/bambu/storageFiles.ts) | The adapter rejects listings above 20,000 files; the native API caps selectable `maxEntries` at 50,000, accumulated names/paths at 16 MiB and individual names/paths at 4096 characters. JSON headers cap at 4 MiB for listings and 64 KiB otherwise; storage enumeration caps at 32 entries. | Neo content/listing budgets, distinct from pagination or snapshot eviction. The inspected Orca list/response handling has no matching fixed thresholds. |
| [Telemetry](../apps/desktop/src/utility/bambu/telemetry.ts) | Payload strings above 4 Mi characters are ignored, which can lose an otherwise parseable status update. | Neo threshold; Orca `MachineObject::parse_json` parses the supplied payload without this gate. This comparison does not qualify the plugin's MQTT packet limits. |
| [Bambu submission IPC](../apps/desktop/src/shared/bambuSubmission.ts), [Storage preparation](../apps/desktop/src/utility/bambu/storagePrints.ts) | Each uploaded artifact is limited to 512 MiB; preparation arrays have fixed 64-element and warning lists 128-element ceilings. Device-file preparation also limits materials/maps to 64 and nozzle diameters to two. | Artifact/IPC ceilings are application-defined. Fixed-dual-tool preparation is declared adapter coverage; device-reported color/nozzle capability checks remain separate. These gates are not imposed by the general inspection parser and need individual compatibility review. |
| [Moonraker agent](../packages/printer-control/src/service.ts) | Advertises and enforces a 2,147,483,647-byte upload ceiling, without reading a server limit. | Neo allocation/adapter policy presented as a capability. Orca's Moonraker uploader submits the source file through the HTTP file form. Actual Moonraker/proxy limits remain server-owned. |
| [Live camera reader](../packages/bambu-native/native/camera.cpp), [muxer](../apps/desktop/src/utility/bambu/cameraMuxer.ts), [delivery](../apps/desktop/src/utility/bambu/mediaChannel.ts) | Native/muxer frame limits of 4 MiB, native queue 64 samples/8 MiB and delivery queue 64 packets/8 MiB can fail playback; shared media IPC/player packet ceilings also apply. | Neo streaming/delivery budgets. Orca uses a different native player path; these numbers must not be labelled printer capabilities or assumed Orca-equivalent. Replacing overflow failure requires coordinated frame/muxer/player handling. |
| [Stored-video cache](../apps/desktop/src/utility/media/storedVideoCache.ts), [MP4 parser](../apps/desktop/src/utility/media/progressiveMp4.ts), [shared playback](../packages/slicer-app/src/components/device/media/storedPlayback.ts) | 2 GiB disk quota, 8 MiB headers, 200,000 samples, 8192-pixel video dimensions, 4 MiB samples/input chunks, 4096 buffered fragments, and shared packet/startup-buffer ceilings can select the download alternative or stop playback. | Explicit Neo embedded-player coverage/budgets, not full-file download or device restrictions. Orca's native player is not a matching parser contract. |
| [Account avatar](../apps/desktop/src/utility/bambu/account.ts) | Avatars above 2 MiB produce no image. | Neo presentation budget; unrelated to device resource validity. |
| [Typed IPC](../apps/desktop/src/shared/bambuControl.ts), [command validation](../apps/desktop/src/shared/bambuCommandValidation.ts), [Storage IPC](../apps/desktop/src/shared/bambuStorage.ts), [media IPC](../apps/desktop/src/shared/bambuMedia.ts), [native CTRL wrapper](../packages/bambu-native/native/control.cpp) | Fixed text/opaque-reference lengths, 128 acknowledged warnings, 16 catalogue references, 8192-character native tunnel URLs and 64 KiB outbound CTRL messages can reject otherwise representable values. | Neo boundary budgets; type/schema, authorization and protocol integer checks are separate. Review each producer/consumer together rather than calling these firmware limits. |

Orca comparison entrypoints are [current-task previews](../packages/slicer-wasm/cpp/src/slic3r/GUI/StatusPanel.cpp),
[streamed object XML](../packages/slicer-wasm/cpp/src/slic3r/GUI/SkipPartCanvas.cpp),
[object-skipping applicability](../packages/slicer-wasm/cpp/src/slic3r/GUI/PartSkipDialog.cpp),
[telemetry parsing](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.cpp), and
[Moonraker file upload](../packages/slicer-wasm/cpp/src/slic3r/Utils/Moonraker.cpp).

Retention and scheduling also expose deliberate host admission policies: thumbnail
cache LRU targets, eight-resource batches, two resource connections, queued/active
request counts, 500-file download batches and 1,000 unfinished tasks. They are not
per-file compatibility limits. Camera history (128 records for five minutes) and
stored-video history (64 records for one minute) can still impose cumulative
open quotas inside their retention windows; they do not use the thumbnail
history's terminal-entry eviction policy. Snapshot/history expiry, request
idempotency and busy results need separate lifecycle review.

Some fixed values have a different basis: Orca's `PartSkipDialog` blocks
skipping plates above 64 objects; PNG picking colour IDs are 24-bit; native ABI
integer widths and valid protocol enums constrain representation. Temperature and
fan ranges derived from device observations, task/configuration ownership,
non-replay of uncertain commands and parser consistency checks remain intact.
No physical control, deletion or print is exercised by this audit.

## 2. Scope and architectural boundaries

The proposed initial modeling focus is non-mixing FDM, including single-extruder,
multi-material, multiple-tool and multiple-nozzle configurations. Resin,
continuous material mixing and general vendor command consoles have not been
designed here; their exclusion from this draft is not a permanent product ban.
Unknown hardware properties are valid; they must not be filled with guessed
defaults merely to match a preferred printer model.

The shared domain owns semantic types, normalized snapshots, capability
descriptions, command outcomes and resource lifetimes. Agents translate vendor
protocols into this contract. A future gateway exposes that boundary across a
process or network; it must not introduce a second printer domain model.
Application features own presentation and explicit project workflows. Hosts
own networking, credential storage and local file access appropriate to their
environment.

The printer domain is independent of slicing and the Emscripten module. No
printer networking is added to the slicer bridge, and no application code gains
direct Emscripten access. OrcaSlicer's behavior can inform adapters, but its
wxWidgets application state, vendor JSON layouts and fixed AMS slot grouping
must not become shared-domain requirements.

The contract must accommodate browser-direct, Electron-hosted and remote-agent
execution without assuming identical capabilities. A LAN or cloud route says
where the connection goes; the agent host says where protocol code executes.
Ordinary-browser reachability, authentication, discovery, upload, control,
telemetry and camera playback need independent qualification. Success in one
does not establish the others. A gateway remains an optional future execution
path, not a dependency of local slicing or an assertion of cloud support.

### 2.1 Bambu Electron provider design

**Foundation scope:** Integrate Bambu account login and printer discovery using
[open-bamboo-networking](https://github.com/ClusterM/open-bamboo-networking).
The selected implementation direction is an Electron Node-API addon hosted
outside the renderer, with shared public provider contracts. It is not the
standalone helper/gateway approach, nor a browser-WASM port. Implementation is
authorized under the independently accepted increments in section 2.2.
The subsequent monitoring/control design is recorded separately in section 2.3;
its selection does not change the delivered scope of those foundation increments.

The [common provider/account boundary](Web-Electron%20Shared%20Application%20Architecture.md#42-service-providers-and-accounts)
owns account methods independently of printers. The Bambu provider implements
both the account and printer interfaces. Its implementation may share native
plugin resources internally; shared UI receives domain results, not plugin
handles, raw credentials or Bambu JSON. Existing printer discovery/adoption and
physical-identity/multiple-route semantics remain the integration boundary.
Concrete registry/facade APIs and configuration migration remain design work.

Cloud-account enumeration and LAN discovery are distinct capabilities, both
selected for the first delivery. Plugin-facing triggers follow Orca. Listing
an account's devices does not establish LAN reachability, and receiving a LAN
announcement does not authenticate a device.

After a successful cloud account-device fetch, automatically populate Neo's
device list and establish the associated Cloud routes. No per-device Add action
is required. This is an account-managed population path, not a requirement to
make every discovered printer from every provider persistent automatically.
It does not select a print target or create a second physical identity when an
existing device already has another route.

A successful refresh with a valid, complete account-device list also removes
that account's Cloud routes for devices absent from the returned list. Preserve
independent LAN routes; remove a device only when no routes remain. A failed
request or an invalid/incomplete response does not authorize removal. A valid
empty list removes all Cloud routes owned by that account. This follows Orca's
account-list reconciliation while retaining Neo's separate route model.

The first delivery does not expose local hide/delete actions for automatically
populated Bambu Cloud devices. Their Cloud routes follow the provider's account
list and logout lifecycle; no local hidden-device registry is introduced.

LAN-only discovery and access-code entry are included without requiring a
Bambu cloud login. The user can select a discovered LAN-only device, supply its
access code and add/access it through the corresponding Orca-compatible plugin
flow. Distinguish a discovery candidate from a device with established access;
receipt of an announcement alone does not grant access. Host-owned credential
handling and native connection operations remain behind the public domain
boundary. This access-code workflow does not remove generic local-only manual
configuration or make device discovery a prerequisite for manual configuration.

The ordinary Discover LAN printers dialog lists only devices absent from the
saved printer catalogue, including printers already present through Cloud.
Match the provider and physical external identity, not display name, model or
current IP address. Catalogue changes update the open list without restarting
discovery and clear a selection that has already been added. Forgetting a
device makes its announcements eligible again when no saved routes remain.
The explicitly targeted Storage authorization-recovery dialog still shows its
existing printer so the user can repair its LAN access.

Automatically remember user-entered LAN access codes in host-owned local device
configuration and restore them after application restart. This is independent
of the plugin's private account/session persistence. Follow Orca's
[access-code handling](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.cpp)
and [local-device save/restore flow](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevManager.cpp),
using Neo's host credential boundary. Cloud account logout preserves independent
LAN devices and their remembered access codes.

Users may forget an added Bambu LAN device. Remove its LAN route and remembered
access code, retaining any independent Cloud route. Remove the saved device
only when no routes remain. Subsequent LAN discovery may show it as an
unauthorized candidate, requiring access-code entry again. This is a local
operation, not cloud unbinding, and follows Orca's LAN removal behavior in
[SelectMachinePop.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/SelectMachinePop.cpp).

For Bambu-managed LAN routes, discovery automatically updates the address when
the same device is found at a new IP. Match the device identity and follow Orca's
connection-name checks when `connection_name` is present; retain the existing
device identity and remembered access code. This does not change generic manual
route configuration behavior.

Bambu device display names follow provider updates from LAN discovery and
Cloud account-device lists, as in Orca's
[DeviceManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevManager.cpp).
The first delivery does not provide local aliases for Bambu devices. A name or
IP change does not create a new physical device identity.

Discovery and local population/adoption do not bind/unbind a device to a Bambu
account. Unsupported printing, upload, control, monitoring and media capabilities
remain unavailable in this phase. Native connection calls needed for Orca's
login/discovery/LAN access flow are in scope without exposing those additional
product capabilities. Profile synchronization remains future work in its own
domain.

On account logout, including automatic logout for authentication expiry under
Orca's error handling, remove that account's saved Cloud routes. Preserve devices
with independent LAN routes and remove devices that have no routes left.
After re-login, a successful account-device fetch automatically restores the
returned Cloud devices/routes; there is no manual re-add step. Do not unbind or
delete devices on Bambu Cloud as part of this local cleanup. Bambu region changes
first log out the old account and apply the same cleanup. Other providers'
accounts/routes are unaffected. Account multiplicity and regional identity
follow the common account boundary. Plugin logout follows Orca's calls; a
transient network error does not automatically imply logout. Late responses
must not restore routes removed by logout or attach them to a different account.
The provider owns this account association, cleanup and stale-result handling;
the concrete internal mechanism remains to be designed. Printer consumers use
provider and printer/route identifiers without an account reference. They apply
provider-published changes rather than implementing account-specific cleanup.

**Plugin compatibility boundary:** Treat the plugin as a black box and follow
Orca's plugin-facing behavior. Implementation must use exported functions,
their return values and registered callbacks. Internal source details are not
an integration contract: do not depend on private token files, refresh code,
HTTP endpoint fallback logic or internal discovery implementation. Do not modify
the plugin to fit a newly invented Neo authentication lifecycle or force private
configuration overrides to disable background behavior.

The current Orca reference is the checked-in C++ submodule revision
`c936ee9a5ce2979b96a80b47783ab4c29d369227`. Relevant host-side authorities are:

- [GUI_App](../packages/slicer-wasm/cpp/src/slic3r/GUI/GUI_App.cpp): network
  initialization configures the data directory, logging, certificates,
  callbacks, country and startup. Preserve the relevant conditional paths,
  including Orca's tracking-disable calls. Login completion connects the server
  and updates the account device list. Reproduce applicable callback/error and
  shutdown handling rather than selecting calls solely by their names.
- [BBLCloudServiceAgent](../packages/slicer-wasm/cpp/src/slic3r/Utils/BBLCloudServiceAgent.cpp):
  delegates lifecycle, account and device-list operations through the plugin;
  it does not independently fetch tokens or schedule token refresh.
- [WebUserLoginDialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/WebUserLoginDialog.cpp)
  and [HttpServer](../packages/slicer-wasm/cpp/src/slic3r/GUI/HttpServer.cpp):
  embedded official login, ticket/profile/session application, external-browser
  handoff and loopback callbacks. Preserve this exchange behind Electron host
  boundaries while keeping secrets out of shared application state.
- [DeviceCore/DevManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevManager.cpp)
  populates the account device collection from plugin results and merges
  accessible LAN-only devices into its device list;
  [SelectMachine](../packages/slicer-wasm/cpp/src/slic3r/GUI/SelectMachine.cpp)
  provides an access-code entry flow for LAN-only devices lacking access.

Remember login automatically through the plugin's persistence behavior. Normal
application shutdown is not user logout. Authentication refresh, startup network
activity and connection maintenance are delegated according to Orca's call
pattern, not replaced with Neo's own on-demand policy. This supersedes the
earlier proposal to suppress MQTT/background activity in the discovery phase;
it does not deliver a Neo monitoring/control UI or profile synchronization.
Public catalogue/configuration reads still do not issue new probes themselves,
and Moonraker remains request-driven. An empty discovery result is not proof of
device absence; manual configuration remains independent.

The native boundary uses Orca's shared plugin declarations and typed function
pointers. [bambu_networking.hpp](../packages/slicer-wasm/cpp/src/slic3r/Utils/bambu_networking.hpp)
defines common data/callback types, while
[BBLNetworkPlugin.hpp](../packages/slicer-wasm/cpp/src/slic3r/Utils/BBLNetworkPlugin.hpp)
declares function-pointer signatures. Follow
[BBLNetworkPlugin.cpp](../packages/slicer-wasm/cpp/src/slic3r/Utils/BBLNetworkPlugin.cpp)
for platform-specific library selection and loading: Windows uses
LoadLibrary/GetProcAddress; macOS/Linux use dlopen/dlsym. Calls above that layer
use the same declarations and symbols. Reuse this pattern in the Node-API
adapter instead of designing different platform ABIs or performing a separate
per-platform ABI/dependency qualification exercise. Normalize externally
returned data, including any device
access credentials, at the host boundary. Compatibility validation must compare
Orca and Neo's applicable API call/return/callback sequences, not assertions
about the plugin's internal implementation. The plugin revision reviewed for
initial feasibility was `331a4f2585f6ebf4393e5f329e3169e38c6a6713`; the exact
shipped version remains to be selected. Bundle a fixed compatible plugin with
Electron, validate it together with the native adapter and update it through
Neo application releases. Do not require a first-use download or manual plugin
installation in this phase.

Use upstream precompiled plugin release artifacts with pinned versions and
file checksums, not a Neo-built copy of the plugin source. The first delivery
targets Windows, macOS and Linux on both x64 and ARM64. Build the native adapter
using the common header-based integration above and package the matching
upstream artifact. Normal builds, loading and feature checks apply; the selected
six-platform scope is not a claim that those checks have already passed.
Do not silently substitute a source build or omit a platform when an upstream
artifact is missing or incompatible.

The [shared architecture](Web-Electron%20Shared%20Application%20Architecture.md#42-service-providers-and-accounts)
owns one Bambu provider utility per independent Electron application instance,
shared by account/printer capabilities and independent of the slicing runtime.
Separate main windows are separate application instances, not consumers of a
cross-instance provider. The first delivery assumes this process
is stable and excludes provider-process crash handling, automatic restart and
manual crash recovery. Normal startup/shutdown cleanup and Orca-compatible
plugin/API errors remain in scope. Do not make crash-recovery scenarios a
first-delivery acceptance requirement.

China-region real-account login, normal restart restoration, explicit logout
and Cloud discovery are validated on the macOS ARM64 development host. Other
regions, additional verification challenges, credential refresh and LAN hardware
remain unqualified. Successful login/listing does not establish permission or
support for later printing. Addon/plugin packaging, packaged startup and
login-window/browser-handoff fixtures pass on all six selected targets, without
an additional ABI qualification gate. These fixtures do not establish real
authentication on every host or endpoint. The grouped open decisions are tracked in the shared
architecture. Browser-login mode, remembered login, black-box lifecycle,
single-account, regional switching, explicit/expiry-triggered logout cleanup,
automatic cloud device population and LAN access-code entry follow the accepted
rules above. Internal persistence is not claimed to use an OS
credential store merely because authentication is delegated to the plugin.

### 2.2 Bambu implementation and acceptance sequence

**Status:** Steps 1–6 (shared contracts, provider composition/device consumers,
the native addon, application-owned utility host, account flow and Cloud device
enumeration) are delivered and accepted on the development host. Step 7 passes
automatic acceptance, with real LAN-only device qualification deferred by the
user. Step 8 packaging and packaged-provider startup acceptance pass on all six
selected targets; the separate real-account/hardware qualification limits are
recorded below.
This sequence implements the
accepted behavior in section 2.1 and the
[shared account boundary](Web-Electron%20Shared%20Application%20Architecture.md#42-service-providers-and-accounts).
Each step is a separately reviewable implementation increment with its own
acceptance evidence. Completing a step does not claim completion of later
features. Keep incomplete Bambu capabilities unavailable in production; test
providers are test fixtures, not an alternate production networking path.

The [printer contracts](../packages/platform-contract/src/printer/service.ts) now
use provider-owned account association, route-targeted rename/forget operations,
local management permissions, access-code authorization and saved-list change
notifications. [Route configuration](../packages/platform-contract/src/printer/printer.ts)
no longer exposes `accountRef`. The
[Device panel](../packages/slicer-app/src/components/device/DevicePanel.tsx)
and [Send dialog](../packages/slicer-app/src/components/send/SendGcodeDialog.tsx)
now subscribe to the unified saved catalogue. The
[provider dispatcher](../packages/printer-control/src/providers.ts) routes by
provider-owned printer/route identity and preserves ownership for outstanding
operations after a route is removed. Conflicting identities fail rather than
merging by display name or address. Failed/stale catalogue reads do not replace
a newer successful projection.

Both hosts compose the existing Moonraker provider. Its configuration form and
console API-key injection retain their existing repository boundary; common
listing and Send no longer read that document. Local configuration changes
invalidate all subscribed consumers, including host-originated Electron changes
and browser storage events. Device renders discovery-only metadata, limits
editing to the Moonraker form, and offers forgetting only on permitted routes.
Manual configurations may retain an optional user-selected vendor/model
association, exposed separately from observed identity in the saved catalogue.
The shared application checks that association, or the provider's reported model
and exact catalogue references when no association is set, using the existing
runtime match query. A device with no known model passes. The printer domain
does not import slicer code or reinterpret provider-reported model identifiers.
The form, filtering and acceptance contract
is owned by [optional manual-device models](Printer%20Console%20and%20Control%20Integration.md#optional-model-for-manually-configured-printers).
Send requires a compatible G-code upload route and, for Send & Print, start
support on that same route. An in-flight upload retains its operation target
when the catalogue changes. Deterministic fixtures exercise multiple consumers
and Bambu Cloud/LAN coexistence. The production host now starts the native
runtime, and the account implementation registers its capability on
Electron. The same provider registers its printer capability alongside the account
capability. LAN authorization and management are implemented; their real-device
qualification remains deferred.

| Step | Deliverable | Prerequisites | Independent acceptance boundary |
| --- | --- | --- | --- |
| 1 | Shared account and printer capability contracts | None | Compile-time consumers and existing host/service compatibility |
| 2 | Provider composition and shared device-list integration | 1 | Existing Moonraker plus deterministic test providers |
| 3 | Pinned plugin artifacts and native addon | None | Real plugin load/version smoke and native boundary tests |
| 4 | Application-owned Electron provider host | 1, 3 | Utility-process, IPC and normal lifecycle integration |
| 5 | Bambu account login and Home/settings UX | 4 | Real login/logout/restart on a development host plus deterministic UI/error cases |
| 6 | Cloud device enumeration and reconciliation | 2, 5 | Real account list plus deterministic route-lifecycle cases |
| 7 | LAN discovery, access and forgetting | 2, 4 | Deterministic persistence/route cases; real LAN-only device qualification deferred |
| 8 | Combined acceptance and six-target release packaging | 5, 6, 7 | Packaged applications and integrated real-account/device evidence |

Steps 1 and 3 can proceed independently. After the common foundations, LAN
work does not require cloud login to be complete. Steps 6 and 7 must converge
on the same provider-owned identity and route state, not separate Bambu device
registries. Each step should be committed after its own checks pass; do not
combine the entire sequence into one implementation commit.

#### Step 1 — Shared contracts and existing-consumer alignment

Create the host-neutral provider identity/account contract module outside
`printer-control`, and inject account capabilities through the platform
boundary. Define account status/summary, login, logout, state changes and
provider settings needed by this delivery. Account-only and printer-only
providers must be representable; a combined provider implements both
interfaces under one identity. Do not implement preset synchronization or a
generic cross-capability account-reference scheme.

Align the single current printer contract: remove caller-supplied account
references from discovery and routes; define how provider-published catalogue
changes reach consumers; and distinguish allowed local configuration actions
from provider-managed Cloud routes. The contract must express LAN access-code
submission and route-specific forgetting without deleting a retained Cloud
route. Keep credential storage host-owned and distinguish local candidate
adoption from the native access flow. Update producers, consumers, mocks and
compile-only fixtures together, without parallel old/new API formats.

**Acceptance:** Type-only consumers prove the separate capabilities, a combined
provider and account-free printer requests. Existing Moonraker tests/typechecks
pass, both hosts still construct their platform adapters, and Web can represent
unavailable Bambu execution without importing Node/Electron/native code. Pure
interface-shape coverage belongs in TypeScript checks rather than runtime tests.

#### Step 2 — Provider composition and device consumers

Introduce provider dispatch and a unified saved-device projection using the
step 1 contract. Preserve existing Moonraker behavior and persisted settings;
its current configuration format and API-key handling can remain private to
its adapter. Do not repurpose that format for Bambu or introduce an unrelated
Moonraker credential-storage migration.

Adapt Device and Send consumers to provider/route identity and supported
operations instead of treating every device as editable Moonraker configuration.
Keep Moonraker forms and its native Web console behavior. A discovery-only
Bambu device may appear in the list without a monitor, embedded console or
send/print action. Add only the capability-driven presentation needed for this
delivery, not the full future device-page suite. Provider-driven additions,
updates and removals must reach all subscribed consumers within the application
instance without a UI account lookup.

**Acceptance:** Deterministic provider fixtures prove dispatch isolation,
catalogue updates, one Bambu identity with Cloud/LAN routes, allowed LAN
forgetting, and disabled/absent unsupported actions. Names or IP addresses
alone do not merge devices. Existing Moonraker manual add/edit/delete, console
selection and upload/start behavior still pass; startup/listing do not introduce
Moonraker probes. Web continues to expose only its supported providers. Fixtures
verify cross-provider coexistence without a Bambu account or native plugin.

#### Step 3 — Native plugin loading and addon boundary

Select the exact upstream precompiled release and record artifact URLs,
versions and checksums for all six selected targets. Add deterministic build
acquisition/staging and the Node-API addon, following Orca's common declarations,
function-pointer signatures and native loader pattern. Wrap the exported
surface needed for login/discovery, including callback and returned-data
ownership; do not expose arbitrary native calls to shared application code.
Build the adapter, not the plugin source. Account/profile/device business
state remains outside the low-level wrapper.

**Acceptance:** A real-plugin smoke loads the selected artifact and obtains its
version through the wrapper on the development host. Native boundary tests
exercise argument/result conversion, callback delivery/lifetime and cleanup
without relying on plugin internals. Confirm upstream artifact availability for
the selected targets early; a missing artifact is an explicit delivery gap,
not a silent source-build fallback or target removal. These are normal build
and loading checks, not a separate per-platform ABI qualification project.

**Delivered native boundary:** [@orca/bambu-native](../packages/bambu-native/src/index.ts)
uses the [pinned v2.2.0 artifacts](../packages/bambu-native/artifacts.json), selecting
the `02.08.04` library series supported by the Orca 2.5.0 declarations. The release
URLs and checksums remain unchanged. All six archives have been SHA-256 verified
and their complete selected ABI directories re-staged, including camera libraries.
The macOS ARM64 plugin reports `02.08.04.99` through the rebuilt addon in both Node
and Electron's Node runtime. No-credentials print-ABI smoke calls return before
network dispatch. Ordinary prints leave the new `queue_plate_id` field empty;
camera URLs use the loaded plugin version, while the upstream HTTP client identity
remains `02.08.01.55`.

Earlier six-platform packaged startup checks in step 8 covered the `02.08.01`
series. They do not qualify startup or packaging of the newly selected series
on the other five targets; that platform execution remains unverified.

The addon copies the required common public typedefs from Orca into one header;
its build checks them against the checked-in source. `LoadLibraryExW` or `dlopen`
selects the matching binary and resolves the same typed symbols. Calls are
serialized off the Node event loop; plugin callbacks are copied into a Node-API
thread-safe queue. Native scheduled functions retain the library until they are
drained/destroyed. Core callbacks and later discovery/HTTP callbacks can be
registered in Orca's separate initialization phases. Normal close clears and
drains callbacks, stops discovery, disconnects the printer, waits for server
idle with Orca's bounded poll, destroys the agent and unloads without logout.
No plugin private state is interpreted.

Build acquisition is explicit (`pnpm --filter @orca/bambu-native acquire`);
application startup never downloads a plugin. `pnpm --filter @orca/bambu-native test`
builds the addon and runs deterministic exported-interface fixtures covering
argument/output ownership, callback lifetime, shutdown and corrupt-artifact
rejection. `pnpm --filter @orca/bambu-native smoke` checks the real pinned plugin's
version on the current host after building. Application-owned process wiring,
account state and discovery projection still belong to later steps.

#### Step 4 — Shared Electron provider process and IPC

Host the addon in one Bambu utility process per Electron application instance,
independent of the slicing utility and shared by account/printer capabilities.
Implement the main/preload/utility bindings for the selected contracts, normal
startup/shutdown and callback dispatch. Apply Orca's configuration-directory,
certificate, region, callback-registration and start ordering; keep Neo's
configuration independent of Orca. Map native results into typed host replies
and events, with no tokens or saved access codes in public snapshots or logs.
Establish one host-owned Bambu device/credential repository for the later Cloud
and LAN steps, so concurrent consumers within the instance cannot overwrite
each other's saved state. This serialization alone is not evidence of
cross-process persistence coordination.
The official login window must not inherit the application's privileged preload.

**Acceptance:** Focused Electron integration proves one provider per application
instance, continued lifetime across page navigation, correct event routing and
cleanup on normal instance shutdown without logout. Separate application
instances do not share live provider state or retarget each other's selection.
Exercise the real plugin's ordinary startup on the development host and compare
the applicable call sequence with Orca. Malformed IPC/native results fail at
the boundary. Do not add crash/restart/backoff tests or recovery machinery.

**Implemented boundary:** The [main host](../apps/desktop/src/main/bambuUtility.ts)
creates one utility process, restricts IPC to application main frames and
validates public replies. The [runtime](../apps/desktop/src/utility/bambu/runtime.ts)
uses the real plugin's Orca-compatible configuration, certificate, region,
headers, callback, startup and discovery sequence. Account restoration reads
only plugin getters. A utility-owned serialized repository stores Neo settings
and future LAN records separately from the opaque plugin directory. Native
callbacks publish only account/catalogue invalidations to application windows.
Normal application exit drains and destroys the agent without logout; no crash
recovery is introduced. Login-window creation is deferred to step 5.

The macOS ARM64 [Electron smoke](../apps/desktop/e2e/bambu-provider.e2e.ts)
starts the real plugin, obtains signed-out state in two isolated windows,
checks one named utility process, closes one window while the other continues
reading, and exits normally. Deterministic tests cover lifecycle ordering,
serialized persistence and IPC rejection. Six-target packaged-runtime
acceptance is recorded in step 8. Public account and printer registration remains absent
at this step; the host's printer projection is empty.
The two-window smoke is existing host-boundary test evidence, not a supported
single-instance multi-main-window product model or proof of independent-instance
qualification.

#### Step 5 — Account login as a complete user flow

Implement plugin-backed account restoration, embedded official login,
system-browser handoff/local callback, explicit logout and Orca-compatible
authentication-expiry handling. Preserve the required post-login calls even
before step 6 exposes their device results. Keep plugin session persistence
opaque and distinguish ordinary network errors from logout.

Add the Home-only login entry and account-state presentation, plus Bambu region
selection in application settings. Default to `Others`, remember the setting,
and apply Orca's region-to-plugin parameter mapping. Reuse/focus an existing
login window; recreate it only after closure. Closing it after browser handoff
does not cancel that login. Region changes log out the old account first.
Web does not advertise Bambu login execution.

**Acceptance:** Complete a real login, explicit logout and remembered-login
restart on the development host. Focused host/UI tests cover window reuse,
external handoff and late completion after window closure, region switching,
auth-expiry notification, transient failure and unavailable plugin state.
Native login payloads remain inside the host. Other provider accounts are
unaffected. Deterministic fixtures can cover unavailable challenges, but actual
regional/challenge coverage must be reported separately from mocked evidence.

**Implemented account boundary:** The [account lifecycle](../apps/desktop/src/utility/bambu/account.ts)
keeps ticket exchange, profile retrieval, login payload preparation, session
changes and expiry handling behind the host boundary. The
[login controller](../apps/desktop/src/main/bambuLogin.ts) closes the embedded
view after payload preparation and before `change_user`, matching Orca's modal
handoff. Its dedicated sandboxed preload exposes only the official page's
`wx.postMessage` bridge; the application bridge is absent. Loopback callbacks
stay in main/utility and survive an embedded-window close after browser handoff.
The Home entry and provider settings use only the common account
contract. Match Orca's User-Agent structure, including a space after the client
version: the official page uses this delimiter to recognize supported login
features. Third-party login requests and popup links open the system browser
while preserving the embedded form and its inputs. Web still has no account provider. No preset synchronization is added.

Deterministic tests cover window reuse, callback lifetime, stale attempts,
region/logout separation from LAN records, public state projection and Orca's
401 grace period. The real plugin starts and the live official sign-in page
loads with the isolated bridge on macOS ARM64. A real China-region account
passes login, remembered-login restart and explicit logout; a further restart
retains signed-out state. The live official page dispatches the localhost and
third-party handoff commands without navigating the embedded form away. This
verifies browser launch dispatch, not completion of a third-party identity
provider challenge. Other regions, third-party completion and challenge flows
remain separately unverified; other platforms remain in step 8.

#### Step 6 — Cloud device population and route lifecycle

Consume Orca-compatible account-device results inside the Bambu provider and
automatically publish saved Cloud routes. Reconcile only valid complete lists;
handle a valid empty list, and retain prior routes on failed/invalid results.
Associate devices using stable provider/device identity. Provider-internal
account context rejects superseded responses; callers never pass account IDs.

Wire explicit logout, expiry logout and region changes to provider-owned Cloud
route removal. Preserve independent LAN routes and remove identities with no
routes left. Re-login repopulates Cloud routes automatically. Update names from
provider results, expose no local aliases or Cloud hide/delete actions, and do
not select a print target or claim control/upload support.

**Acceptance:** A real account's device list appears through the common Device
surface. Deterministic cases cover additions, renames, absent devices, empty
lists, failed refreshes, logout/re-login and responses arriving after account
changes. A LAN-route fixture proves Cloud cleanup cannot delete that route;
the combined real LAN case follows in step 8. Subscribed consumers within one
instance see the same provider result without duplicate saved devices.

**Implemented boundary:** The [device owner](../apps/desktop/src/utility/bambu/devices.ts)
consumes the plugin's complete `devices` result, keyed by `dev_id`, with Orca's
name/model fields. It commits validated lists atomically and rejects failed,
malformed, duplicate-identity, superseded-session and superseded-request results.
A valid empty result clears Cloud routes. Plugin-supplied access codes never
create independent LAN access or enter the public catalogue. Logout, expiry and
region replacement clear the Cloud session while preserving separately
remembered LAN records.

The [Electron provider](../apps/desktop/src/renderer/src/platform/bambuProvider.ts)
implements both public capability interfaces and converts a whitelisted host
projection into common printer identities/routes. Local catalogue reads do not
call the network. Login/restoration and explicit account discovery use the
plugin's `get_user_print_info` export; list querying is separate from the native
server-connected callback. Every Bambu print/control/upload/observation/media
capability remains unsupported. Cloud routes expose no rename/configure/forget
permission. Multiple consumers receive catalogue invalidations from the same
utility owner.

On macOS ARM64 a real China-region account's Cloud device appears through the
common Device surface without automatic selection. Deterministic coverage
verifies complete/empty/failed reconciliation, renaming, stale responses,
multiple consumers and logout that preserves a separately authorized LAN
fixture. Real combined Cloud/LAN qualification remains in steps 7–8.

#### Step 7 — LAN discovery and remembered access

Expose LAN candidates and the access-code/add flow through the same provider
and Device surface, including operation without a cloud login. Follow Orca's
plugin call/callback pattern for discovery and access; an announcement alone
does not grant access. Persist user-entered access codes in host-owned local
configuration and restore them after normal restart. Input is transient UI
data; saved codes are not returned in catalogue/account snapshots.

Update addresses for the same identity using Orca's connection-name rules,
follow reported names, and combine Cloud/LAN routes when identity is established.
Forgetting removes only the LAN route and its code; rediscovery requires access
entry again. Keep generic manual configuration independent from discovery and
preserve LAN routes/codes across cloud logout. No monitoring/control UI is added
because the native access flow happens to connect internally.

**Acceptance:** Discover and add a real LAN-only device while logged out of
Cloud, restart and reuse its saved access, then forget it and require access
entry again. Deterministic cases cover invalid codes, expired candidates,
IP/name updates, Cloud/LAN identity association, retained Cloud routes on LAN
forgetting, and retained LAN routes on logout. No remembered code is exposed by
the public saved-device model. Real network observations and fixture-driven
edge cases are recorded as different evidence.

**Implementation accepted with hardware qualification deferred:** The
[LAN owner](../apps/desktop/src/utility/bambu/lan.ts) treats plugin SSDP messages
as expiring candidates and keeps `connection_name` association within the
current process, as Orca does. Same-device address/name updates preserve the
remembered code and invalidate obsolete route revisions. Restart restores only
explicitly authorized host records; re-verification can reuse a saved code
without returning it to the UI. After forgetting, blank-code reuse is rejected
until the user enters access again. No plugin-private configuration is read or
modified directly.

Explicit LAN authorization follows Orca's native selection, connection and
callback initialization pattern. A successful local callback precedes saving;
incorrect-code, missing-callback, stale-candidate and closing-app cases do not
create a saved route. Bootstrap messages and certificate setup remain private
host operations and do not enable product control/monitoring capabilities.
Host mutations serialize across clients. Forgetting compares the current route
revision and removes only its LAN record, preserving independent Cloud routes.

The shared [Device discovery UI](../packages/slicer-app/src/components/device/PrinterDiscovery.tsx)
uses public provider discovery/authorization operations, shows masked transient
access input and hides already saved devices in ordinary discovery. Targeted
Storage recovery retains authorization for the existing device. It does not select a
print target. Deterministic native/host/provider/UI fixtures cover this boundary,
including code rejection, callback order, expiry, restart reuse, address rules
and Cloud/LAN cleanup. The real plugin's ordinary startup remains qualified;
actual LAN-only authentication, restart/reuse and forgetting have not been
verified on hardware. The user has deferred these real-device checks and
authorized the implementation commit and step 8. Keep the outstanding hardware
journey in combined release qualification; automatic acceptance does not
establish real-device support.

#### Step 8 — Packaged delivery and combined acceptance

The [native resource stage](../packages/bambu-native/scripts/stage.mjs) builds
the Node-API addon on the target host and acquires the checksum-pinned upstream
plugin. Normal desktop development/build/E2E entry points prepare these inputs;
the packaging hook performs the same preparation for the requested target.
[electron-builder.yml](../apps/desktop/electron-builder.yml) keeps bundled
JavaScript and excludes production node_modules, while explicit extra resources
carry the addon, the complete plugin directory and Orca's complete public
certificate directory outside asar. The existing `set_cert_file` call still
passes the certificate directory and `slicer_base64.cer`; `printer.cer` is
preserved alongside it. No user download or manual installation is required.

The [six-target CI matrix](../.github/workflows/ci.yml) uses native runners and
matching Node architectures. Each package runs real-plugin startup,
configuration restart and isolated-login/system-browser handoff probes against
its packaged app directory. Production builds use the real WASM runtime;
the separate E2E build mode retains the mock slicer fixture. The engineering
[packaging reference](../doc/2026-09-25-github-pages-deployment.md#desktop-packaging)
owns the build procedure.

**Packaged delivery acceptance:** Installers are produced for Windows, Linux and
macOS on both x64 and ARM64. Each packaged app passes real-plugin startup,
configuration restart, isolated-login-window reuse and system-browser handoff
checks on a matching native CI runner. Login-page fixtures prove host behavior
without authenticating a real account. The macOS ARM64 app installed from the
DMG separately restores the real
China-region Neo test account and its Cloud catalogue across normal restart,
including common Device rows without automatic target selection. This
qualifies the six-target packaging/startup boundary; it does not close the
separate real-account and hardware limits below.

**Separate real-account/hardware qualification:** The combined device journey
still covers real login, automatic Cloud population,
LAN access, a combined identity, logout retaining LAN, re-login, LAN forgetting
and application restart. Record CN/international results and any untested
challenge/device/environment explicitly. Packaging success alone does not prove
real login or discovery. No additional ABI gate or process-crash qualification
is introduced. LAN hardware qualification remains deferred as authorized in step
7; international account/challenge journeys and real-account authentication on
the other hosts remain unverified. These limits do not reopen the accepted
six-target packaging and startup checks.

#### Verification and completion rules

Follow [testing guidelines](../doc/testing_guidelines.md): each step runs the
affected package tests/typechecks and focused host checks for its changed
boundary; contract changes also update compile-only consumers. Code handoffs
run `pnpm test`, `pnpm typecheck` and the relevant Electron/Web seam tests.
Follow the repository release matrix for final release qualification; do not
repeat it at every step. No slicer C++/WASM change is planned, so a step does not
require a WASM rebuild merely because the native networking addon changed.

Use exported-call/callback fixtures derived from the checked-in Orca caller,
not plugin implementation details. A fake plugin/provider proves host behavior,
not Bambu service compatibility. Real plugin/account/device evidence is required
at the indicated steps; unavailable evidence remains unverified. Keep secrets
out of committed fixtures and reports. Use the existing documentation owners
for contract/behavior changes, and update the Grand Plan only when delivered
work actually changes milestone status.

### 2.3 Bambu monitoring and control design

**Decision status:** One shared capability- and topology-driven Monitor composes
control cards for all providers. Bambu supplies normalized observations and advanced
command capabilities, with H2D + AMS as the first physical acceptance
target. Implementation is authorized in independently tested and committed
increments; physical qualification is performed last. The
[console specification](Printer%20Console%20and%20Control%20Integration.md#bambu-control-design)
owns the feature envelope, presentation and grouped interaction decisions,
including that control increment's exclusions of video, file browsing and an
HMS tab. The separately accepted camera follow-up is defined in section 8.1.

#### Execution and ownership

Extend the existing provider and application-owned Bambu utility, retaining the
native addon and pinned black-box networking plugin. Shared React code accesses
the typed printer service through the platform adapter. The utility owns device
message interpretation, native connection coordination, observation caches and
command execution/tracking. Account association, credentials and raw messages
remain host-private. No wxWidgets GUI port, slicer-WASM dependency or new browser
gateway is part of this design. Provider-process crash recovery remains outside
the existing first-delivery scope; ordinary transport failures still need
accurate observations and operation outcomes.

The [renderer provider](../apps/desktop/src/renderer/src/platform/bambuProvider.ts)
now binds typed observations, control requests and operation lookups to the
utility. The [native boundary](../packages/bambu-native/src/index.ts) exposes
Cloud/LAN sends and subscription control. The utility normalizes push reports,
keeps a target-scoped cache, validates current conditions at dispatch, and treats
native send/ACK separately from observed completion. H2D/H2D Pro protocol defaults
come from the pinned Orca resource tables and are overridden by reported values;
these defaults never instantiate hardware units, slots, tools or paths. Manual
extrusion uses the reported loaded/selected material minimum temperature and
blocks when that requirement is unknown. Other unsupported or unknown device
commands remain unavailable instead of guessing a protocol or hardware layout.
Physical execution and cross-instance integration remain qualification work.

Retain independently addressed requests. Reading, subscribing or evaluating
availability must not become a caller prerequisite for command submission.
Capabilities must include sufficient information to construct requests, and
execution revalidates the target, route, supplied revisions, parameters and
relevant device conditions. Unsupported and unknown capabilities remain distinct.
Model/firmware information and retained observations inform resource constraints;
an account-list entry alone does not prove every control is supported.

#### Observation and connection coordination

The provider must interpret complete and incremental messages according to the
reference [DeviceManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.cpp)
and [JSON reconstruction logic](../packages/slicer-wasm/cpp/src/slic3r/Utils/json_diff.cpp).
Maintain a valid reconstruction baseline, recover from missing baselines/gaps,
and preserve unknown/stale readings rather than inventing zeros or idle state.
Normalize units, tool/resource identities and model-specific state in the
provider. Emit coherent topic snapshots/replacements with route and configuration
provenance. Late events from removed routes, superseded connections or logged-out
accounts must not repopulate current observations.

Each independent application's utility coordinates native state across its own
account/printer consumers. Existing
[LAN access](../apps/desktop/src/utility/bambu/lan.ts) maintains one active device,
and Orca's
[device selection](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevManager.cpp)
switches LAN connections or the selected Cloud device. Neo does not support
multiple main windows sharing one application instance; do not add a shared
selection, window contention or connection-takeover protocol between independent
instances. Within an instance, native target changes must still preserve the
target and outcome of pending operations and reject obsolete callbacks.

Packed Bambu report fields are decoded in the host-private
[telemetry parser](../apps/desktop/src/utility/bambu/telemetry.ts). Control,
recovery and print rules consume named protocol state instead of interpreting
bit positions themselves. After each accepted complete/incremental report is
merged, the telemetry owner replaces its immutable parsed machine state.
Consumers share that state through the host-private command context; reading a
context does not repeat protocol decoding. Freshness is evaluated separately.
Missing report values retain their unknown state and legacy-field precedence;
protocol details do not enter shared domain interfaces.
Following Orca, only `msg: 1` merges into the existing report baseline; `msg: 0`
and reports without `msg` replace it. Explicit `cfg` values override legacy
force-upgrade and speed fields, including zero. Upgrade display state takes
precedence over legacy upgrade status strings; the five legacy in-progress
statuses remain recognized when display state is absent.

Keep ordinary monitoring focused on the selected printer. On selection change,
release the old printer's ordinary monitoring connection/selection/subscription
as applicable, retain its cached data with actual freshness, and acquire the new
printer's state. Do not accumulate monitoring for previously visited printers.
A pending operation does not block selection. Preserve its original target,
route and identity, and continue necessary result tracking where the native
protocol permits; inability to confirm after switching yields an unknown outcome,
not a fabricated success. Switching does not cancel, replay or redirect commands.
Late results update only the original operation and must not contaminate the new
printer's snapshots. Retaining an operation record does not imply the native
plugin can maintain simultaneous live telemetry for every old target.

Instances share persistent configuration and plugin configuration storage, not
the provider runtime. Reuse remembered login, saved devices and last-selection
preferences; do not assign a profile directory per process. Do not proactively
synchronize login/logout/account switches to other running instances. New
instances restore the latest saved state; existing instances respond normally
to server/plugin session invalidation and remove invalid account-owned routes.
The plugin remains responsible for its private session format and refresh;
shared storage does not authorize reading or rewriting private auth files.
Qualify concurrent startup/writes/shutdown and account changes across independent
processes. Within-instance write serialization alone is insufficient evidence,
and stale saved snapshots must not resurrect removed account/device state.
Orca's reference uses a shared default data directory and local account handlers
in [GUI_App](../packages/slicer-wasm/cpp/src/slic3r/GUI/GUI_App.cpp); this is not
proof of black-box plugin concurrency behavior.

For Bambu control, expose a single stable `automatic` agent route per physical
printer. Cloud membership and independently saved LAN credentials remain
provider-owned access metadata, not two caller-selected control endpoints.
The native agent handles account-backed LAN/Cloud networking. Both Cloud and
local message callbacks normalize into the same device state, and command ACKs
and completion observations are correlated by physical device and command
identity, independent of callback channel. This follows Orca's callback wiring
in `GUI_App` and `MachineObject::parse_json` / `publish_json` in `DeviceManager`.
Failure of one channel does not stale another channel's fresh observations;
all-data loss retains marked stale readings and blocks new commands. Transport
changes do not change the logical route ID or its configuration revision.
Account/credential configuration changes do change the revision, invalidate old
guards and reconcile access to the same printer; retained LAN-only access does
not accept late Cloud callbacks after logout. No automatic transition replays
an already dispatched command or invents capabilities. The UI has no transport
selection policy or manual transport switch.

UI observation lifetime, provider connection lifetime and operation lifetime are
separate. Stopping a view subscription does not cancel a physical operation.
Bambu observation starts automatically when the selected printer's control view
is shown. Leaving that view pauses hidden UI updates while the provider retains
the connection, receives status and updates its cache. Outstanding operations
continue to be tracked. The console specification owns these accepted behaviors
and restoration of the last selected Device printer across all providers.
Restoring a Moonraker selection does not authorize background observation.

The provider owns one shared device-access layer for native connection selection,
normalized base state, access leases and the serialized command queue. LAN
access-code authorization uses that same connection owner. Resource readers,
camera access and print submission depend on this base layer; it must not call
back into monitoring or feature projections. Monitoring composes recovery alerts
and current-task object state above it, with required dependencies supplied at
construction. Command validation and business-context assembly remain inside the
device-access queue turn that sends the command. Captured device reads retain
their observation metadata across temporary lease cleanup; private base contexts
never leave the utility host in public snapshots.

Rendering a captured observation must not advance or roll back current recovery
episodes, invalidate the current object catalogue, or cancel resource reads.
Historical errors that no longer match the current recovery episode retain base
diagnostics without recovery actions or a modal. Current device events and guarded
command preparation retain ownership of business lifecycle updates.

Protocol field decoding and resource lookup must not depend on telemetry or
feature implementations. Shared host-private control contracts distinguish base
device state from recovery and object-skipping projections. Feature projection
inputs use base state; command dispatch consumes the assembled context. These
contracts must not import their implementation owners, including through type-only
back-references. Both runtime and type-only local imports must remain acyclic.

#### Object skipping follow-up

**Decision status:** Design accepted; implementation authorized in independently
accepted and committed increments. This follow-up
supersedes the original control increment's object-skipping exclusion only for
the scope recorded here. Software acceptance is recorded below; no physical-printer or real-remote
qualification is claimed.

Use option B: the provider obtains the printer's current task object resources,
independently of the active Neo workspace or a Neo-originated print submission.
The first delivery includes Electron Bambu LAN and Cloud remote access; remote
object-resource acquisition is part of that delivery, not a deferred enhancement.
LAN access does not require the printer to run in LAN-only mode. Static-Web
Bambu access, a browser gateway and Moonraker/Klipper execution are outside this
first delivery. Shared contracts and presentation remain provider-neutral.

For object-resource acquisition, follow Orca's local-first strategy: try local
TCP using valid existing device authorization, then fall back to the remote
tunnel for non-LAN-only printers when local acquisition fails. LAN-only printers
remain local. This resource-read strategy does not change the selected command
target or control route; skipping commands retain that route's authorization
and validation.

Enable support by provider-normalized device capabilities and valid current-task
object information, without an H2D-only model allowlist. H2D is the first
physical acceptance target; its acceptance does not qualify other models.
Record model and access-path qualification separately.

**Design assumption:** Treat the networking plugin as supporting the required
local and remote control-stream resource reads, and design the Orca-compatible
tunnel path on that assumption. Do not pursue an HTTPS project/task-resource
replacement as part of this work. The pinned `open-bamboo-networking v2.2.0`
[camera-URL implementation](https://github.com/ClusterM/open-bamboo-networking/blob/v2.2.0/src/abi_camera.cpp)
does not implement TUTK/Agora remote tunnels. It returns a LAN URL when device
IP and authorization are known, otherwise an empty URL. This known runtime
limitation does not narrow the accepted remote scope or block completion of this
design discussion. It remains separate from the assumed plugin capability;
Cloud MQTT and exported local stream symbols do not qualify remote resource
reads. No plugin change, replacement or remote hardware acceptance is claimed.

The native resource-read increment is implemented in `@orca/bambu-native`.
`ControlStream` owns a separate source-library/thread lifetime, starts CTRL
stream type `0x3001`, bounds outgoing request admission, and pauses native pulls
while two owned incoming packets await the consumer. Close is idempotent and joins off the JavaScript thread before releasing
the tunnel/library. `readBambuProjectResource` permits only current-project
object metadata and indexed picking PNGs, issues Orca's `get_project_file` /
`mem:/16` request, excludes parameter metadata from file bytes, validates chunk
offsets/lengths and final MD5, and retains read deadlines. It adds no resource-size,
packet-size, fragment-count, response-header-size or parameter-metadata-size
budget. These transport changes do not remove downstream object-catalogue or
picking-image restrictions listed in section 1.4.
Local success does not resolve a remote ticket; local failure may invoke the
explicit remote resolver, while cancellation and LAN-only access do not trigger
remote fallback. Returned bytes are owned and errors omit private URLs.
This wrapper is independent of camera playback and the networking-agent call
queue; plugin calls already in progress finish before native close resolves.
The Electron Bambu provider now acquires current-task catalogues and picking
maps through this reader. It parses bounded XML for the reported plate, binds
opaque references to device/route configuration, task provenance and metadata
fingerprint, and maps native labels privately. Missing or foreign `s_obj` IDs
remain unknown. Image failures retain list operation. Resource reads own temporary
monitor leases, support IPC cancellation and revalidate context after acquisition;
task changes abort in-flight reads. Task, job, plate and file transitions clear
previous object-skip reports until the device supplies current state. Device bit
49 controls support, while phase,
freshness, label enablement and the 64-object limit control applicability.
Dispatch revalidates selection and explicit stop intent inside the native command
queue. Independent batches confirm only from matching device state; ACKs alone
do not alter the reported skipped count. These checks are covered by provider
fixtures, including external tasks, 63/64/65 objects, stale recovery, task changes,
configuration changes, cancellation and malformed resources. Physical LAN/remote
and model qualification remain outstanding.

An unavailable picking image does not invalidate an otherwise reliable object
catalogue. List-only operation requires confirmed object IDs, names,
object-skipping support and current-task provenance. If the catalogue or its
task association cannot be established, object skipping is unavailable.
The [console specification](Printer%20Console%20and%20Control%20Integration.md#object-skipping)
owns degraded presentation and selection lifetime during task changes,
disconnection and concurrent skipping by other clients.

Task identity is part of object-command validity: revalidate it before dispatch
and reject an operation prepared for an earlier task. Stale or disconnected
state cannot authorize object skipping. Recovery requires fresh evidence that
the task is unchanged. Concurrent object-state changes must not silently
convert a partial skip request into whole-print cancellation.
Do not require a previous batch's device confirmation before admitting another
batch. Track operation outcomes independently without adding a global lock for
pending or uncertain prior skipping operations. Preserve current-task validation
and the existing prohibition on automatically replaying uncertain commands.

The shared domain needs a typed current-task object catalogue/resource boundary
and a typed batch skip command. A catalogue carries provider-issued task/object
references, object names, skipping availability and reported skipped state;
image bytes are obtained on demand rather than repeated in status updates.
References bind printer, route/configuration and current task/catalogue context.
The provider validates them independently at dispatch, including selected object
membership and whether the requested partial skip is still applicable. Names,
array positions, filenames and the current Neo scene are not object authority.
An object reference addresses a printed instance, not a child volume of a
multipart model. Already skipped instances have no restore operation.

The shared contract increment is implemented as the `printObjects` observation
topic, `media.readPrintObjectMap` and `jobs.skipObjects`. The command carries a
`PrintObjectContextRef`, a non-empty opaque object-ID array and explicit
`skip-selected` or `cancel-print` intent. `PrintObjectSnapshot` carries names,
availability and a self-contained `Reading` of device-reported skipped IDs;
`PrintObjectMap` carries on-demand PNG bytes and a colour-ID-to-opaque-object
palette. The Bambu IPC boundary rejects empty, duplicate, oversized and malformed
selections and raw protocol fields. Electron Bambu implements these capabilities; other adapters retain explicit
unsupported results. Raw telemetry alone does not fabricate a file-backed
catalogue.

Catalogue reads must work without a caller-owned observation session, file
listing, print history lookup or Neo submission record. Provider-internal reads
and leases may obtain current device evidence. Check context before and after
asynchronous acquisition and again at dispatch; discard late resources for a
different task/target. If reliable task association cannot be established, return
unavailability rather than invent identity from the filename. These local checks
do not establish atomic task validation inside firmware: Orca's skip wire command
carries object IDs, not a firmware-enforced expected-task guard.

Keep Bambu normalization, credentials, URLs, XML interpretation and stream
ownership inside the utility/native provider boundary. Use the existing
black-box plugin and control-stream ABI rather than porting wxWidgets
`PrinterFileSystem` or introducing a renderer network client. Extend the native
wrapper for bounded, cancellable task-resource reads; ensure its lifetime does
not block telemetry or depend on camera playback. Shared React consumes typed
resources only. The adapter maps batch instance references to Orca's
`print.command=skip_objects`, `obj_list` and QoS 1, derives device support from
the normalized part-skip capability (`fun` bit 49), and normalizes `s_obj`
without treating an absent report as an empty skipped set.

For Neo-originated printing, complete the existing
[print-package bridge](../packages/slicer-wasm/src/bridge_print_submission.cpp)
so the retained slice's instance catalogue and picking resources are included
using Orca's archive conventions. G-code labels, `identify_id` and picking-image
IDs must agree, including imported/loaded identities and the submitted archive's
single-plate index normalization. Rendering and packaging must refer to the
same valid slice receipt, not a subsequently edited live scene. Direct WASM
access remains behind the typed client/runtime boundary. This does not expand
project-input persistence into saving generated slicing results.

The print-package producer increment is implemented. Both dispatch archives
contain the sliced-instance catalogue and `Metadata/pick_1.png` /
`Metadata/top_1.png`, generated from the retained model on its Worker. Picking
uses a lossless 512-square orthographic raster with zero reserved for background;
the two image buffers and depth buffer require about 4 MiB temporarily per
export, without a renderer GL context or continuous render loop. IDs outside the
map's 24-bit range omit the image while retaining catalogue data for list-only
operation. Export-copy identities are normalized to the G-code's per-instance
label policy without mutating the live model. The shared Monitor consumes these
resources through the typed provider workflow. Mobile product support remains deferred under the shared
application policy.

Verification must cover real packaged object metadata and picking IDs, multiple
instances, multipart objects, plate normalization, stale slice receipts, malformed
resources, task changes during read/confirmation/dispatch, transport recovery,
concurrent skipping and independent consecutive operations. Exercise Orca's
object-count limit, including 63/64/65 instances: the reference UI permits 64
but the encoder asserts fewer than 64, so inclusive-boundary compatibility needs
explicit validation. Protocol fixtures must check exact skip/stop payloads and
device-derived `s_obj` state. Update contracts, producers, consumers, IPC
validation, mocks and compile fixtures together; use affected-package checks,
focused Electron journeys and applicable WASM builds/smokes under
[testing guidance](../doc/testing_guidelines.md).

Software acceptance covers the real serial WASM producer through the Bambu
catalogue/map consumer: two independent instances, imported H2D loaded IDs and
63/64/65-instance plates. The harness inflates the actual PNGs, checks every
catalogue/pixel/G-code identity, and verifies all 63 or 64 distinct bits in the
emitted eight-byte `M624` masks. The provider accepts up to 64 and rejects a
65-object catalogue for skipping. This boundary evidence is from the existing
Release WASM artifacts; the upstream encoder's strict `< 64` debug assertion is
unchanged and debug-boundary qualification is not claimed.

To reproduce the producer-to-consumer check from the repository root:

```sh
node packages/slicer-wasm/harness/print-submission-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js /tmp/orca-object-resources
ORCA_OBJECT_RESOURCES=/tmp/orca-object-resources pnpm --filter @orca/desktop exec vitest run src/utility/bambu/objectSkipping.test.ts
```

The output directory is a generated local test artifact. Ordinary unit runs skip
this opt-in case when it is absent; the acceptance run explicitly supplies it.
The reader's source transport is injected for this check, while the native
packet/cleanup fixtures and Electron IPC/selection journey qualify their own
boundaries. This combination does not establish a real plugin-to-printer path.

The implementation handoff gate passed repository tests (with the generated
resource case explicitly enabled), repository typechecks, the four focused
Electron object/control/submission journeys, renderer CSS/import guards and
`git diff --check`. The native wrapper's 28 fixtures and the desktop provider's
418 tests passed. Existing serial and threaded WASM trees were quick-built;
serial passed the comprehensive bridge, slicing, DRC and STEP smokes, and threaded
passed startup/threaded slicing. The ordinary conditional WASM/runtime skips
remain outside this feature's acceptance. Full Web/release matrices, six-target
native packaging and physical skips were not run for this development handoff.

Physical acceptance starts with H2D and separately exercises LAN and genuinely
remote access, including a print started by another client, partial skipping,
consecutive batches, paused-print behavior and explicitly confirmed whole-print
cancellation. Confirm that remaining objects continue printing. Fixtures, plugin
symbols and successful command submission do not replace physical acceptance;
the assumed remote capability must be verified against the actual execution
plugin when remote acceptance is performed.

Implementation follows these dependency-ordered acceptance increments. Complete
the affected checks and commit each increment before starting the next; shared
contract changes must keep every producer, consumer and fixture buildable.

| Increment | Independently accepted result | Acceptance boundary |
| --- | --- | --- |
| Print-package object resources | Retained-slice instance catalogue and lossless picking resources in both dispatch archives | Real WASM package/PNG/G-code identity checks, affected WASM package tests/typecheck and quick build |
| Shared object contracts | Typed resources, batch commands, capabilities and validation with unsupported adapters kept coherent | Domain compile fixtures, affected adapter/IPC checks and package tests/typecheck |
| Native task-resource reads | Bounded, cancellable local/remote control-stream acquisition with deterministic cleanup | Native fixtures for transport selection, fragments, limits, cancellation and lifetime; native ABI/build checks |
| Bambu object execution | Current-task catalogue/state, guarded batch skipping and explicit whole-print cancellation | Exact protocol, stale-task/concurrency/recovery and independent-operation tests; provider IPC integration |
| Monitor interaction | Capability-gated modal picking/list flow and all accepted selection/confirmation/count behavior | Component tests and focused Electron journeys, including image-unavailable fallback |
| Integrated acceptance | Producer-to-consumer software regression with qualification limits stated | Repository tests/typecheck, affected host/WASM checks and separately recorded physical acceptance |

#### Material information configuration follow-up

**Delivery status:** Implemented; Orca is the selected behavioral reference.
Product behavior and accepted interaction decisions are owned by the
[console design](Printer%20Console%20and%20Control%20Integration.md#material-information-configuration).
Its [verification record](Printer%20Console%20and%20Control%20Integration.md#material-configuration-verification-and-lan-acceptance)
limits physical acceptance to the recorded development-host H2D LAN cases.
Cloud, RFID actions and non-default/legacy calibration behavior have software
coverage without physical qualification.

Keep the existing shared material-unit, slot, path and tool model. AMS and
external holders use the same normalized information-editing flow; vendor
addresses, catalogue translation, firmware flags and RFID classification belong
to the Bambu provider. Shared components do not parse virtual holder IDs or
construct protocol payloads. Preserve existing printer/route/configuration
provenance and command checks; the selected Orca-aligned design adds no separate
material-version conflict interaction.

**Native catalogue boundary:** Add a typed read-only query through the existing
client/runtime/Worker boundary. Reuse
[PresetBundle](../packages/slicer-wasm/cpp/src/libslic3r/PresetBundle.cpp)'s
device-oriented candidate and variant helpers and reproduce the relevant
[dialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/AMSMaterialsSetting.cpp)
selection and ordering rules without building wxWidgets for WASM. The existing
project-compatible filament catalogue cannot stand in for that query. Native
code owns profile inheritance, candidate compatibility, identities and resolved
temperature values. Querying must not switch or mutate the active project,
edited presets, visibility or history. No Orca core/submodule change is currently
identified as necessary; discovering one requires reassessing that boundary.
Candidate sources are the system and saved user libraries, subject to Orca's
existing native eligibility checks. Project-embedded presets, unsaved overlays
and retained snapshots do not become independent candidates or supply their
temporary effective values to device writes. Preserve the saved/root identity
when resolving project-use ordering.

**Material contract boundary:** Extend the single current normalized contract
to represent the applicable nozzle-temperature range, selected material's
preset association and typed slot-scoped Confirm/Reset intent. Model writable
information separately from action availability: RFID-derived information can
remain read-only while Confirm/Reset perform automatic calibration operations.
Do not fabricate a metadata patch to execute a calibration-only action. Direct
K/N editing, user-selected calibration results and calibration launch remain
outside this follow-up; its automatic calibration effects are explicitly in
scope. Keep material catalogue identity distinct from a preset setting identity,
and distinguish information clearing from physical filament presence. Use the
saved-library eligibility above. Exact normalized fields are implementation
details within these boundaries. Update producers, consumers, adapters, mocks
and compile fixtures together. Do not introduce a parallel Bambu-only editor
contract or arbitrary vendor payload escape hatch.

**Device color boundary:** Confirm accepts one typed solid RGBA edit, an ordered
gradient edit, or `null` to retain the target's currently reported color tuple.
The last form preserves existing partitions and groups beyond the editing limit
without accepting arbitrary vendor fields from the renderer. Alpha is the last
HEX byte. Following Orca #16538, the Bambu provider reads `fun2` bit 23 and exposes
`maxGradientColors: 4` or `null` (solid-only). Explicit new gradients require that
capability and 2–4 colors. For capable firmware, information writes send `cols`
and `ctype` alongside `tray_color`: a new gradient uses ordered RGBA entries,
type `0` and its first color as representative; a new solid uses one entry and
type `2`. Unedited reported groups retain their ordering, repeats, alpha, type
and independent representative. Without the flag, omit `cols`/`ctype` as Orca
does; Reset also omits them. A gradient write requires a matching full tuple in
the receipt or later status before completion can be confirmed. Received
setting replies may update only their actual fields and never refresh general
status; a partial representative on capable firmware does not erase its group.
No outgoing command is projected optimistically as device state.

**Provider execution boundary:** Reuse existing native networking and operation
tracking. Follow
[MachineObject::command_ams_filament_settings](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.cpp)
for setting fields, clear values and AMS/external address conversion, including
the independently reported dual-tool external holders. Preserve Orca's
device/protocol-specific automatic calibration writes and result-association
selection/reset on Confirm/Reset, in the reference order after any applicable
material-information write. An RFID-only action omits the information write.
Derive internal calibration state/defaults from the reference rules and device
context, without adding calibration editing controls or asking shared React to
construct protocol commands. Keep Orca/Bambu filament identity translation
inside the agent. All protocol steps retain the original target and
configuration provenance and require separately correlated outcomes. Preserve
the reference's independent ordered dispatch: attempt the later calibration
step even after an earlier information-write send failure, without waiting for
the earlier step's acknowledgement. Continuation does not permit retargeting
or bypassing existing access/configuration checks. Track the sequence as one
user intent with separate step outcomes; no early acknowledgement or successful
step may mask another step's failure or unknown outcome. This is not an atomic
transaction and has no automatic rollback or retry.

Add corresponding setting-reply/cache handling as well as status-report updates;
current telemetry primarily consumes push status. Distinguish device acceptance
from state confirmed by applicable device reports, and do not promote an outgoing
request to observed inventory. The dialog closes after successful provider
submission, independently of outcome tracking, as specified by the console
owner. Transport dispatch success alone is not proof of confirmed physical
state. Late replies remain bound to the original operation, target and
configuration even after the editor closes or device selection changes.

Verification must distinguish native query purity and catalogue parity, typed
contract coherence, exact provider requests and responses, and shared interaction
from real printer writes. Both existing LAN and Cloud execution paths are in
scope; initial physical qualification is H2D over LAN, with Cloud covered by
software verification only. No software fixture or existing read-only material
acceptance establishes configuration-write qualification.

The delivered contracts expose `materials.configure` with a fixed slot,
Confirm/Reset intent and explicit warning acknowledgements. Capability targets
separate `informationWritable`, allowed actions and a normalized restriction;
they also supply the native nozzle/tool catalogue context. Material observations
retain nullable temperature bounds and a separate preset-setting association.
The read-only `getDeviceMaterialCatalogue` client/runtime operation returns saved
material identities, labels and resolved temperature variants. It uses the
normalized descriptor identity, including catalogue model references, rather than
requiring the renderer to translate a vendor model code.

The [Bambu owner](../apps/desktop/src/utility/bambu/materialSettings.ts) performs
applicable one-shot calibration-history reads, evaluates pinned material rules,
and prepares a nonempty ordered command array. The
[operation owner](../apps/desktop/src/utility/bambu/operations.ts) correlates each
step independently and applies the explicit continuation policy. No legacy
`followUp` payload shape remains. Setting replies update only existing addressed
tray fields; they do not refresh status freshness or infer physical removal.
The shared Monitor retains operation references for the original target across
editor closure and selection changes. A receipt arriving after the original
Monitor remounts notifies that target's current reader. It only reconciles uncertain submissions
through lookup, never by resending a mutation. Warning help links use the
host-injected external-link capability with HTTPS validation at the host boundary.

#### Contract extension boundaries

The current typed contract includes `jobs.setSpeed` with discoverable mode IDs
and labels, and `hardware.refreshNozzles` for explicit device re-identification.
Nozzle records include nullable type and flow type alongside material and diameter.
`flowReporting` distinguishes supported, explicitly unsupported and unknown reporting;
a missing flow value on an unknown device must not become a Standard-flow default.
Print status includes individually unknown-capable device task identity, detailed
stage, current/total layers and speed mode. Device task identity is independent
of Neo jobs; an optional `expectedTaskId` guard must be checked or explicitly
rejected, never silently ignored. No prior observation is mandatory.

`currentPrintPreview` declares image-format support independently of files and
cameras. `media.readCurrentPrintPreview` resolves the current device task and
returns image bytes with printer, route, configuration and task identity. It
requires no file listing, history or watch; consumers discard late images that
do not match the displayed task/target. Private source URLs stay in the provider.
Moonraker leaves these new capabilities unsupported and new status fields unknown.
These contract additions alone do not enable Bambu runtime execution.

Existing domain types cover basic thermal, actuator, motion, tool and material
operations. They are a starting point, not evidence of complete H2D support.
The following gaps need coordinated contract/specification/consumer updates:

- Detailed print stages and layer counts, and selectable printing-speed modes.
- Independently obtainable current-task thumbnail resources, without requiring
  file browsing, history lookup or correlation with a Neo-submitted job.
- Reported per-nozzle hardware details and an explicit supported nozzle
  refresh/re-identification operation, distinct from an ordinary observation read.
- Reported material topology, read-only metadata and load/unload/switch constraints
  wherever existing types cannot faithfully express device-supported targets.
  Keep protocol-specific temperature derivation inside the provider; no dedicated
  per-operation temperature override is exposed.
- Jogging distinguishes a distance/speed request from a named firmware step and
  direction. Extrusion speed is either explicitly specified or device-controlled;
  providers must reject the wrong request kind rather than silently discard a
  distance or speed. Capability constraints supply the available request kind.

Do not add calibration-start, print-detection configuration, camera recording,
timelapse/resolution settings, object-skipping, material-metadata editing, manual
RFID re-read, drying-control or AMS behavior-settings executors for the original
control increment. Object skipping has a separately accepted
[follow-up design](#object-skipping-follow-up), with implementation unstarted.
Material information configuration has a separate
[delivered follow-up](#material-information-configuration-follow-up);
its executor remains separate from the original control increment.
Drying/environment observations remain included. These restrictions do not remove
load/unload/switch, contextual recovery or supported nozzle re-identification.
Their exclusion from this implementation does not remove existing general domain
contracts or disable device-side features. Calibration started elsewhere remains
observable. Per-nozzle details are read-only and must not mutate printer
configuration or slicer presets.

Current-task image resources must retain target, route and current-task
provenance without exposing private vendor payloads. Missing or failed image
retrieval does not make basic print status unavailable. Task changes and late
image results must not display an earlier task's image as the current one.
The exact typed resource representation remains a contract-design decision;
do not force file-list support merely to expose a current-task thumbnail.

Prefer shared semantics where they fit, with narrowly typed Bambu-specific
extensions where necessary. The exact extension representation remains open;
do not introduce arbitrary vendor JSON or string-command escape hatches.
Contextual action references carry the selected inline device-issued recovery
actions, not arbitrary parameterized settings. If general calibration is added
in a later scope, it still needs its own semantics. Update the single current
contract, producers, consumers and compile fixtures together. Check for hidden
session prerequisites, incomplete capability-to-request construction and unsafe
widened unions before implementation.

H2D acceptance must distinguish tools/nozzles, material units/slots and paths to
each tool. Keep actual and requested tool/path state distinct when a transition
is in progress. Derive topology and capabilities from device reports; do not
assume a fixed AMS count, generation, slot layout or transfer mechanism. Resolve
the physical fixture details at hardware acceptance. A unique usable feed target
can be used directly and displayed; multiple targets require explicit selection,
and unknown routing or an unready mechanism blocks execution with an explanation.
The provider owns the reference load/unload temperature policy, including
validation of protocol-specific sentinel/default behavior; uncertain applicability
must not become a guessed temperature. The accepted interaction boundaries are in
[Materials and AMS behavior](Printer%20Console%20and%20Control%20Integration.md#accepted-materials-and-ams-behavior).
Telemetry must not silently mutate the slicer's project or presets.

#### Commands and acceptance boundaries

Use the operation semantics in section 7. A successful native send is not
physical completion. Define confirmation evidence for each command: setting a
temperature target is different from waiting for that temperature, and material
movement needs an appropriate terminal result. Preserve unknown outcomes after
ambiguous dispatch; do not automatically resend motion or material commands.
The provider owns request deduplication, protocol response correlation and
operation lookup independently of the view. The implementation retains requests
and operation records for the current utility lifetime, with a 30-second ordinary
completion timeout. Material load/switch/unload allow ten minutes for firmware
warm-up, feeding and wiping, following the multi-minute LAN load observation.
Telemetry becomes stale after 15 seconds; explicit reads time out after
10 seconds. Target temperatures, fan/light settings, task state, tools and material
paths can complete only from a newly accepted report satisfying the command's
predicate. ACK is recorded separately. Jog/home/extrusion, identification refresh
and recovery currently have no proven physical-completion predicate. A correlated
successful device ACK ends their tracking in the command-only `accepted` phase,
clears the timeout and releases the operation's observation lease. This records
device acceptance without claiming physical completion. Missing ACKs still time
out as unknown; explicit device rejection remains failed. Commands with a
completion predicate retain nonterminal `acknowledged` tracking until observed
completion or timeout. Hardware acceptance must verify these
observations against firmware behavior. No outcomes survive utility restart. The selected UI follows
Orca's corresponding control states, local messages and necessary dialogs; it
does not add a unified operation-history panel or uniformly persistent outcome
badges. This does not weaken underlying outcome tracking or replay restrictions.
Relevant device errors and supported contextual recovery actions remain included
in the control cards; an independent HMS page remains excluded.
Current errors may carry agent-directed dialog presentation alongside their inline
alert. Bambu uses pinned English error/action resources selected by serial prefix;
[recovery](../apps/desktop/src/utility/bambu/recovery.ts) owns action definitions
and opaque references scoped to the observed error, device task and configuration.
Closing a dialog and clearing an error are distinct protocol operations. All
underlying error/job fields and severity are decoded in the cached machine state;
ordinary partial reports preserve omitted fields. Legacy AMS acknowledgement also
sends Orca's separate UI-close notification. Commands are never replayed because
an error remains visible. The shared UI contains no Bambu codes or wire payloads.
See the [console behavior](Printer%20Console%20and%20Control%20Integration.md#accepted-task-hardware-and-recovery-scope)
for dialog lifetime and current implementation limits.

For Bambu FAILED reports, explicit print error 0300400C means task cancellation
according to Orca's checked-in HMS resources. Project it as cancelled/ready with
an informational cancellation message; other failures remain failed/error. A
running task is not cancelled merely because that code appears. If firmware
clears the reason before a new utility obtains its baseline, FAILED alone cannot
establish cancellation and retains the failure projection. Do not synthesize a
confirmed cancellation from a stop request or carry operation outcomes across
utility restarts. The scoped H2D LAN physical qualification and these limits are
recorded in the console's
[LAN round completion](Printer%20Console%20and%20Control%20Integration.md#independent-lan-real-task-controls-and-round-completion).

Follow the accepted
[command interaction](Printer%20Console%20and%20Control%20Integration.md#accepted-command-interaction):
confirm print cancellation with printer/task identity; do not add generic
pause/resume or manual-motion confirmations; submit valid temperature edits on
Enter or focus loss without duplicate submission. Preserve the original command
target across edits and dialogs and reject a changed/invalid context at dispatch.
Check motion prerequisites before sending, without automatically heating or
replaying a blocked movement. Disconnected, connecting or stale-state views
retain marked old readings but disable new controls until valid state returns.
Do not queue new commands for later replay on reconnection. The provider validates
operation-specific conditions independently of UI availability.

Qualification must cover independently reviewable boundaries: contract
construction; read-only monitoring and route lifecycle; basic controls;
material/tool routing; and the agreed advanced controls. Deterministic fixtures
cover complete/incremental data, unsupported or missing readings, stale routes,
independent-instance isolation, device-selection changes, deduplication,
switching during pending commands without cancellation/replay, release of old
ordinary monitoring, correct late-result routing, uncertain command outcomes,
stale recovery contexts and late/missing task thumbnails. Cover cancellation context changes, Enter/focus-loss deduplication,
temperature edit target changes, control disabling/restoration on stale state,
and pre-dispatch motion checks without automatic heating or movement replay.
Check read-only nozzle details, explicit refresh capability and
absence of the excluded calibration/detection/camera/object-skipping controls.
Also cover dynamic material topology, unique/ambiguous/unavailable feed targets,
load/unload temperature applicability and read-only material/drying observations.
Verify absence of metadata editing, RFID re-read, drying controls and AMS settings.
Physical H2D + AMS evidence must establish the operations actually claimed.
Qualify account-backed automatic networking, including mixed callbacks, first;
then separately qualify independently authorized LAN-only access. Pure Cloud
and transport-loss claims need explicit network evidence, but are not a
prerequisite for ordinary mixed-network acceptance.
Confirm the precise AMS hardware and routing during physical acceptance. Passing
one route or model does not qualify another. Independently running Electron
processes must demonstrate the accepted shared-persistence and non-synchronized
account behavior, including invalidation and concurrent-write cases; a historical
single-process multi-window fixture does not qualify this behavior.

Follow [testing guidelines](../doc/testing_guidelines.md) for affected-package
tests/typechecks, contract fixtures, host E2E and repository handoff checks.
Native export changes require affected addon/plugin and packaged-host checks,
with the existing six-target release obligations retained. No slicer WASM build
is implied by a networking-addon-only change. Existing real-account acceptance
and packaged startup do not prove control authorization or physical execution.

### 2.4 Local-artifact print submission

**Decision status:** The user selected option B for this feature: a shared
print-preparation experience and vendor-independent print-submission contract,
with agent-owned upload/start orchestration. Initially only the Bambu agent
enables this new capability. This is distinct from the earlier domain-wide
option B in section 1. Existing Moonraker upload/start behavior remains current.
Implementation is authorized in independently verified stages. Accepted product
decisions, implementation validation gates and explicitly deferred behavior are
recorded below. Delivery status is tracked separately from those decisions.

#### Implementation progress

The runtime now exposes receipt-bound `describePrintPlate` and `exportPrintPlate`.
Both read the retained native slice result and reject stale generations. Native
`store_bbs_3mf` creates a single-plate print archive and a configuration archive
from that result; the typed client consumes their temporary MEMFS paths and
returns bytes. Material requirements preserve original filament indices and fixed
tool assignments, including H2D dual tools. Dynamic mapping is identified for
the future agent's eligibility check, rather than silently flattened.

The real-WASM [artifact smoke](../packages/slicer-wasm/harness/print-submission-smoke.mjs)
checks archive entries, exact retained G-code bytes, H2D nozzle metadata and
stale-result rejection. Serial quick build, this smoke, client tests and
typecheck pass on the development host. This runtime stage does not enable a
printer capability or qualify physical printing. The shared UI integration and
physical-printer qualification remain separate delivery gates.

The host-only Bambu native wrapper now exposes independent LAN/Cloud print calls
with numeric progress, out-of-queue cancellation and conservative dispatch
evidence. Ordinary status requests remain available during upload; teardown waits
for the active call before clearing callbacks or unloading. The by-value
`PrintParams` layout is checked against the pinned source, and calls reject other
ABI series. Native fixtures cover cancellation, concurrent admission, dispatch
races and release ordering. The real v2.2.0 macOS ARM64 plugin passes
`node packages/bambu-native/scripts/smoke.mjs --print-abi`, which deliberately
omits address/credentials and verifies rejection before network I/O. This does
not constitute LAN or Cloud print acceptance.

The shared `PrinterSubmissions` contract and Bambu agent implementation now cover
preparation, bounded artifact transfer, idempotent admission, cancellation,
known-failure retry, qualified LAN preference and safe Cloud fallback. The agent
owns model-resource rules, physical-tool mapping, material catalog conversion,
options and storage checks. At the start of sending, it reads connection data,
selects a route and validates the request once. Following Orca's `PrintJob`,
this prepared state is retained through connection setup and native sending;
intervening device updates do not trigger another route selection or full
validation. Cancellation and the qualified LAN-to-Cloud failure fallback
remain active.
Following Orca, successful plugin completion ends submission as `sent`; physical
print progress is observed separately in Device. An unknown outcome is retained
as a record without an automatic retry; it releases submission resources and
allows printer selection changes.
Native material-ID conversion changes dispatch metadata only, not the project.

Validation includes 13 mapping/lifecycle tests, the desktop and printer-control
unit suites, typechecks, the serial native quick build and real-WASM archive
smoke. Fixture acceptance is not LAN or Cloud physical-print qualification.
The following shared-UI stage activates this capability only for Bambu; other
agents retain their existing interfaces. See the console specification for
software delivery and physical qualification status.

The final integration pass adds Orca's P1 compatibility-confirmation exceptions,
mixed AMS Lite tray numbering, hidden Shared PA semantics, high-chamber and
loaded-material softening diagnostics, selected-AMS drying checks, manual-PA
and smart-nozzle-blob advisories. Native-generated print packages pass directly
to the networking plugin without host-side ZIP/XML reinspection. Recording
cleanup requires an explicit per-submission action. Recording-capacity queries
belong to send-time preparation only; confirmation reuses that result and native
sending does not query again. Direct submission does not require a prior
preparation call or capacity result. Cancellation before cleanup admission or
while cleanup is pending prevents the subsequent print call. Device monitoring
releases its view subscription while the modal owns an independent target;
a submission keeps its own agent lease.

Validation on 2026-10-28 (development macOS ARM64):

- `pnpm test`: 2,688 passed, five conditional skips at the full-suite checkpoint.
  Subsequent focused runs pass 330 desktop tests, the shared send/Device tests,
  six preparation-panel tests and 657 client tests.
- `pnpm typecheck` and `pnpm --filter @orca/platform-contract test:import-guard`
  pass. `git diff --check` and the added local documentation links pass.
- `bash scripts/build.sh quick --variant serial -j 8` and the corresponding
  `--variant threaded` build pass. The artifact smoke passes against both,
  including material-ID conversion and Auto For Flush resolved fixed tools.
  The minimal imported H2D fixture emits existing missing per-extruder preset
  diagnostics; it proves archive/assignment behavior, not printable settings.
- Four focused Electron journeys pass: Bambu control, Bambu print submission,
  Moonraker send/retry, and keyless Moonraker Send & Print. The real-Web
  multipart send/start journey passes in Chrome. The renderer CSS smoke and
  `pnpm --filter @orca/desktop build` pass; the preparation screenshot was
  inspected for layout and readable controls.

Development-host LAN qualification includes two completed fixed-right-nozzle H2D
prints and a completed fixed-dual-nozzle print, all without a Filament Track Switch.
The single-source case uses a 10 mm PETG cube on Textured PEI, fed by AMS 2 Pro B1.
The dual-source case uses two 10 mm PETG cubes on the same plate, with AMS 0 A2
feeding the left nozzle and AMS 2 Pro 1 B1 feeding the right. The user confirmed
normal feeding, first-layer extrusion and dual-nozzle switching, then confirmed
both cubes completed without visible defects or missing material. The device
reported 50/50 layers, completion, readiness and zero heater targets. Qualification
covers these fixed-tool PETG paths only; other supply paths, Cloud physical
printing and the broader host/release matrix remain unqualified.

The dual-nozzle run paused before the first layer at error `0500808F` (dirty nozzle
camera lens). The user continued that same task through Orca or the printer; Neo
observed the error clear and printing resume without issuing a recovery command
or another submission. Neo now exposes Orca's bundled error text and its separate
ignore-and-resume and problem-solved-and-resume actions through generic alert
dialogs, with protocol
and UI fixture coverage. This physical round preceded that implementation and
does not qualify Neo's handling of recovery; ordinary Resume was not tested as
an equivalent action.

Fixed Bambu nozzle assignments must preserve Orca's inactive hotend placeholder
(`H-1`), rather than requesting an explicit hotend through `H0`/`H1`, which can
make an H2D require a Filament Track Switch. The pinned Orca correction and the
real-WASM artifact smoke cover this distinction in both local WASM variants.
The actual LAN submission archive was also checked before the repaired print.

Submission completion follows Orca's plugin-return semantics. A nonnegative
native result reports **Print job sent** and closes the modal in favor of the
target's Device page. It does not assert physical print start. No filename/task
matching, extra full-status request or print-start confirmation timer is required.
Actual preparation, feeding and print progress remain Device observations. The
user-visible task name remains unchanged. A failed call that may already have
dispatched remains `unknown` without automatic resend or fallback. Once the
native call settles, release its temporary files and monitoring lease before
publishing that outcome. Printer selection is not locked by print submissions;
changing selection does not cancel the physical print. Regression tests cover
success without status reports, native reader cleanup and cancellation racing
dispatch. The 2026-10-29 repeat on production build `87c7f259` physically verified
the revised modal transition: one authorized LAN send closed the dialog and
selected Fox and Fox in Device, displaying `LAN-Cube-10mm`; the printer then
completed all 50 layers. Its fresh export retained all four fixed-hotend `H-1`
commands. This closes the modal-transition retest for that fixed-right-tool path.
The completed dual-nozzle case also verified that transition on production build
`574c6f0d`, displaying `LAN-Dual-Tool-10mm`; other supply paths and Cloud printing
remain outside physical qualification.

The [console specification](Printer%20Console%20and%20Control%20Integration.md#print-preparation-and-submission)
owns the interaction, mapping review and feature envelope. This section owns
artifact provenance, agent responsibilities, submission and outcome semantics.
The application-wide host/runtime boundaries remain unchanged.

The accepted initial scope is owned by the console's
[delivery envelope](Printer%20Console%20and%20Control%20Integration.md#accepted-initial-delivery-envelope):
ordinary single-nozzle and H2D fixed dual-tool printing, both LAN and Cloud,
and one valid Neo-sliced plate per submission. Rack/special dynamic mapping,
external print-package import, remote-file reprinting and multi-plate queues
are deferred. Automatic slicing that produces fixed tool assignments is included.
The console also owns the accepted
[entry and selection](Printer%20Console%20and%20Control%20Integration.md#accepted-entry-and-selection):
reuse Send & Print, initialize from Device selection or leave empty, and use a
modal bound to the workspace's current plate/result. Project edits and new
slicing are blocked while it is open; underlying result validity checks remain.

#### Selected responsibility boundary

Submitting a local printable artifact and starting an existing remote file are
different operations. Retain the latter meaning for the existing `jobs.start`
contract. Add a separately advertised submission capability for agents that
accept local artifacts and orchestrate delivery and start. Its exact API name
and DTO decomposition remain implementation choices; do not expose Bambu's
`PrintParams` or an arbitrary vendor-options bag in the shared application.

The existing file-upload API must not report a fabricated remote file merely
because a combined plugin operation has begun. Bambu file browsing, downloading
and deletion are not prerequisites for submitting a local print. Other agents
may adopt the common capability later; this feature does not require doing so.

Public assessment and submission requests remain independently addressed.
An assessment supplies useful candidates, constraints and diagnostics, but
submission cannot require a previous assessment call, connection call or UI
session. The agent validates the complete request and current relevant device
conditions when sending begins. Bambu retains that prepared state during the
send, following Orca; it does not promise an atomic snapshot spanning asynchronous
connection and upload work. Capability support and current availability remain
separate.

#### Artifact and material provenance

Keep two separate mappings: slicing assigns project materials to printing
tools; submission assigns the completed artifact's material requirements to
physical supply paths. Submission must preserve the tool assignments encoded
by the slice. Changing those assignments requires the applicable slicing
workflow, not a silent substitution during dispatch.

The runtime projection is bound to a completed plate result receipt.
It describes used material requirements, their artifact identities and original
indices, material properties, tool/nozzle requirements, printer compatibility,
estimated consumption and print duration. Do not infer the used requirements
from the current editable rack, palette order or coincident device slot indices.
Resolve automatic slicing assignments from the retained completed generation.
The projection and artifact export must refer to that same generation. The
runtime's receipt check rejects stale/unavailable results under the existing
publication contract; the shared UI does not compare serialized manifest contents.

Extend runtime/client/native bridge export to build the required print artifact
from the retained result. Reuse Orca's existing 3MF writer and archive contract;
ordinary project persistence is not a substitute for a sliced print package.
Any Cloud configuration artifact must share the same result provenance.
Shared application code still reaches WASM only through the runtime/client.
Native networking, host temporary paths and credentials remain outside WASM.

Material bindings use domain supply paths, preserving unit, slot and tool
relationships. The Bambu agent privately converts them to native AMS/slot
encodings, external-holder sentinels and nozzle numbering. Whole-plan validation
must cover combinations that are individually reachable but incompatible
together. Device telemetry and submission selections do not implicitly import
materials into the project or modify project history.
The console's accepted
[basic material mapping](Printer%20Console%20and%20Control%20Integration.md#accepted-basic-material-mapping)
defines automatic suggestions, ordinary AMS reuse, the external-holder type
exception and dialog-local binding lifetime. The Bambu agent applies Orca's
model-resource mixed-supply policy; the shared application must not branch on
model names. A refresh revalidates the existing plan without substituting paths.
The accepted
[observation and assistance rules](Printer%20Console%20and%20Control%20Integration.md#accepted-observation-and-external-assistance-behavior)
permit explicit selection of an occupied AMS slot with unidentified material,
while keeping unknown metadata distinct from stale state. Normal refresh does
not suspend an otherwise valid submission; disconnection or expired critical
state blocks a new start until automatic recovery and revalidation. External
multicolor assistance is included, defaults off and uses actual device-reported
support normalized by the Bambu agent, independently of model-based mixing rules.

The accepted
[print options and preferences](Printer%20Console%20and%20Control%20Integration.md#accepted-print-options-and-preferences)
include calibration, timelapse and shared PA options with Orca's capability and
effect conditions. The agent normalizes supported choices and validates their
effective values; automatic calibration remains distinct from on/off. User
option changes persist immediately, including after dialog cancellation, per
stable physical printer identity in a separate section of `printer-config.json`.
LAN and Cloud routes of the same printer share those preferences. Extend the
host-injected configuration schema, normalization and concurrent merge paths
together, without coupling preference changes to connection revisions or
credential ownership. Storage-location choices also persist per printer;
temporary fallback or submission-only disabling does not overwrite the user's
saved preference. The accepted
[timelapse storage behavior](Printer%20Console%20and%20Control%20Integration.md#accepted-timelapse-storage-behavior)
permits an explicitly confirmed oldest-video cleanup action before printing
under Orca's supported conditions. The Bambu agent owns capacity queries and
cleanup execution. Capacity-query failure or timeout is advisory and cannot
authorize deletion or bypass other critical checks. Material bindings and
external multicolor assistance retain their separately accepted dialog-local
rules.

The accepted
[compatibility checks](Printer%20Console%20and%20Control%20Integration.md#accepted-compatibility-checks-and-acknowledgements)
keep Orca's model compatibility policy and material prohibition/warning severity
in the Bambu agent. Shared UI renders blocking or confirmable diagnostics.
Nozzle-diameter mismatches permit explicit acknowledgement scoped to the current
dialog, physical printer and mismatch content. Material prohibitions cannot be
overridden; material warnings require submission-specific confirmation. These
acknowledgements are not durable printer preferences and cannot waive unrelated
blocking checks. Known nozzle hardness insufficiency blocks sending, while
unknown nozzle material produces an advisory that hardness cannot be verified.
For devices supporting nozzle flow-type reporting, invalid data or a mismatch
with the slicing requirement blocks sending without override; unsupported
devices skip that check. Agent-owned readiness gates preserve preparation
choices while the device is busy or not ready. Recovery re-enables the action
for an explicit user click, never an automatically queued print.
Print-file storage checks follow Orca's model/transport conditions and its
persistent global Allow Abnormal Storage preference, default off; this override
does not waive missing-card or read-only checks. Special-material flow
calibration restrictions remain agent-owned: unsupported Auto blocks sending,
whereas On follows Orca's calibration-skipped advisory behavior.
Other applicable pre-print checks follow Orca's conditions and severity in the
agent, with the explicitly accepted Neo differences taking precedence and
deferred hardware modes remaining excluded.

#### Submission lifecycle and host execution

Reuse explicit target/configuration provenance, request identity and operation
tracking. Keep artifact reception, validation, transfer and start dispatch
distinguishable. Transfer completion, successful native return,
device acceptance and observed print start are different evidence. Unknown
outcomes must survive observer interruption and must not trigger a blind second
start or automatic LAN-to-Cloud resend. Agent-side physical transport selection
stays behind the existing Bambu automatic route and must not retarget an
outstanding submission when the UI selects another printer. Prefer LAN when its
requirements are satisfied, otherwise Cloud when available, and expose the
selected transport to the observer. Fallback requires affirmative evidence that
printing has not been initiated. No LAN-only sending preference is included in
this delivery.

Closing an observer is not cancellation. The accepted
[cancellation and closure rules](Printer%20Console%20and%20Control%20Integration.md#accepted-sending-paths-cancellation-and-closure)
allow preparation/upload cancellation but require authoritative termination and
non-start evidence before reporting cancelled and returning to preparation.
After possible start dispatch, reconcile the outcome instead; physical print
cancellation remains a separate action. An explicit unknown outcome permits
observer closure and printer selection changes without retaining a connection
lease; its recorded outcome remains available. The accepted
[success and retry interaction](Printer%20Console%20and%20Control%20Integration.md#accepted-success-presentation-and-retry)
navigates to the target's Device status after successful plugin completion,
matching Orca's sending interaction. Physical print start is observed there,
independently of the terminal `sent` submission phase. Ordinary
send failures expose a direct retry through the normal sending flow, with no
additional recovery wizard. Unknown outcomes retain their reconciliation
boundary. Reconciliation timing and operation retention are implementation
validation items: timeout or expiry is not evidence that no print started.
The accepted
[shared application-exit contract](Printer%20Console%20and%20Control%20Integration.md#application-exit-with-unfinished-sends)
covers every sending flow, including existing Moonraker and Bambu execution and
the planned Snapmaker agent. Keep unfinished-send activity visible to the host
close coordinator independently of renderer page/dialog ownership. After the
user confirms exit, request supported cancellation, prevent unsent stages and
complete required provider/worker teardown without treating shutdown as a
physical print-stop request. Web leave confirmation and teardown remain
best-effort under browser constraints. Restart must not automatically resume or
replay interrupted sends. The shared service tracks admitted sends independently of UI observers, and
application leases cover artifact preparation before admission. This does not
replace provider-specific outcome or cleanup contracts.
Progress must represent the evidence available: native stage/percentage reports do not justify
inventing byte counts or transfer speeds.

The existing native wrapper serializes calls and its addon rejects concurrent
invocations. Long-running print functions therefore require an explicit task,
callback, cancellation and shutdown design; appending cancellation to the same
blocked queue is insufficient. Preserve plugin lifetime until callbacks and
native work have finished. Bounded artifact transport and host-private temporary
file ownership/cleanup must be designed with this lifecycle.

#### Reference implementation and feasibility limits

The initial source comparison used Neo `cb9f9558` and its pinned Orca source
`c936ee9a5c`. Orca's
[SelectMachineDialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/SelectMachine.cpp)
collects mapping and print options, performs device checks and prepares the job.
[DevMappingUtil](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevMapping.cpp)
matches eligible supply slots by material type/color with further tie-breaking.
[Plater](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp) exports print/config
3MF artifacts, and [PrintJob](../packages/slicer-wasm/cpp/src/slic3r/GUI/Jobs/PrintJob.cpp)
invokes the network plugin's combined transfer/start functions. These GUI-bound
classes are behavioral references, not components to port into WASM.

Neo already has result receipts, plain G-code export, ordinary project export,
material topology/inventory, Bambu observations/controls and generic operation
tracking. Its existing Send path selects plain G-code and submits empty material
bindings. The Bambu provider currently advertises neither file upload nor
`jobs.start`, and the native wrapper does not expose the print entry points.
The common contract alone is not an executable print workflow.

The plugin version is owned by
[artifacts.json](../packages/bambu-native/artifacts.json). The inspected v2.2.0
[LAN implementation](https://github.com/ClusterM/open-bamboo-networking/blob/v2.2.0/src/print_job.cpp)
can return success after publishing the start message; this is not independent
proof that printing began. Its
[status document](https://github.com/ClusterM/open-bamboo-networking/blob/v2.2.0/STATUS.md)
records separate Cloud prerequisites and qualification limits. Existing login,
enumeration or monitoring does not qualify Cloud submission. Validate the
fixed plugin ABI, including the by-value print parameter structure, rather than
copying a newer upstream structure or relying solely on existing typedef checks.

No print-package execution, native print-call fixture, build or physical print
was performed by this initial read-only investigation. A focused artifact/native
feasibility check is proposed before broad implementation. Both LAN and Cloud
are now required by the accepted delivery envelope. Cloud prerequisites or
qualification failures remain explicit blockers to that portion of delivery;
successful LAN execution cannot substitute for Cloud acceptance. The accepted
first physical acceptance phase is **H2D with AMS over LAN**. Cloud physical
acceptance is deferred to a later phase while Cloud remains in the functional
design scope. Record LAN results independently; do not label Cloud or untested
single-nozzle models as physically qualified. Artifact and native-ABI feasibility
must be established before the capability is enabled for real submissions;
transport/fallback follows the accepted rules above.

#### Implementation validation and deferred scope

The product clarification baseline is complete for this increment. The following
engineering checks remain necessary before implementation can claim the accepted
behavior; this documentation commit does not satisfy them or authorize physical
printing. API names, timeout constants and internal task representation are
implementation choices constrained by the accepted behavior, not separate user
workflows.

| Boundary | Required evidence or explicit deferral |
| --- | --- |
| Runtime artifact | Inspect real exported print/config 3MF artifacts and material/tool metadata from the same retained slice result; ordinary project export or a mocked archive is insufficient. |
| Native plugin | Verify pinned ABI/symbols, callback and cancellation behavior, task ownership and safe release. Long-running sends must not prevent cancellation or required device observations. |
| Agent execution | Exercise validation, automatic path selection, duplicate requests, concurrent admission, cancellation races and late/unknown results. No new queue or blind retry may be inferred from a busy call or timeout. |
| Shared UI and persistence | Verify capability gating, modal result binding, mapping preservation, direct retry, success navigation, preference normalization and independent-instance writes; preserve the existing Moonraker path. |
| Physical acceptance | First phase: H2D with AMS over LAN, including actual mapped material feed and print-start observation. Cloud physical acceptance is deferred; other device and release claims require separate qualification. |
| Application exit | Qualify the shared unfinished-send exit guard across all existing sending paths: wait versus stop-and-exit, hidden-dialog ownership, cancellation/start races, native callback/worker teardown, Web leave limitations and no automatic resume after restart. Existing provider outcome and cleanup boundaries still apply. |

Acceptance covers artifact/result coherence, used-material extraction,
tool-number conversion, invalid/unknown paths, combination rules, stale context,
manual-selection preservation, cancellation, duplicate requests and unknown
post-dispatch outcomes. Real WASM artifact inspection and physical material feed
and print-start verification are required in addition to mocks. Follow the
[testing guidelines](../doc/testing_guidelines.md) for check scope; a fixture
does not establish a device, Cloud or cross-platform delivery claim.

### 2.5 Snapmaker agent design

**Status:** Implemented and software-qualified in independently tested commits.
Manual connection, U1 project/mapping integration, prepared submission, Device
controls and preferences, scoped monitoring and shared unfinished-send exit
handling are delivered. Software checks, bounded non-printing real-U1 LAN
acceptance and completed single-head and four-head PLA prints are recorded in
the interaction specification. Many-to-one logical materials and shared-heater
qualification remain pending.
Scope, behavior and
acceptance policy are settled. The
[interaction specification](Printer%20Console%20and%20Control%20Integration.md#snapmaker-agent-design)
owns the user-facing decisions. Software acceptance can complete implementation
independently of real-U1 qualification, which remains separately reported.
Existing Bambu and Moonraker behavior remains authoritative for those agents,
with the shared unfinished-send exit extension explicitly accepted above.

#### Entry point and reuse boundaries

Add a distinct `snapmaker` choice to the manual printer agent dropdown. Its
selection chooses the Snapmaker protocol implementation. A configured printer
model does not silently change the selected agent. Manual configuration reuses
the existing API base URL, optional API key and optional console URL. Electron
also supports explicit U1 LAN discovery through the injected, provider-neutral
[`mdns` host capability](Web-Electron%20Shared%20Application%20Architecture.md#4-platform-boundary).
Static Web retains manual configuration without a multicast implementation.
Initial protocol implementation and
acceptance cover U1; the agent name leaves room for later models without
claiming their support now.

U1 discovery browses `_snapmaker._tcp.local.` and accepts TXT
`machine_type=Snapmaker U1` with a non-empty `sn`. TXT `device_name` supplies
the display name; `sn` supplies stable identity and deduplication across renamed
instances. Both `lan` and `wan` link modes are discoverable. Resolved addresses
take precedence over the redundant TXT `ip`. The advertised SRV port is LAN
MQTT (1884); the existing HTTP agent uses the resolved IP at port 7125 instead.
Newly adopted U1 connections default their model association to
`Snapmaker / Snapmaker U1` and their Console URL to `http://<resolved-IP>/`
(Fluidd, default HTTP port). This does not select nozzle variants, activate
presets or change the project's Printer. Discovery does not establish nozzle
configuration.
Protocol evidence is the official
[U1 registrar](https://github.com/Snapmaker/u1-moonraker/blob/ed7b3752a9a938c87ee086f3b7b21a9352a2a0c9/moonraker/components/zeroconf.py#L153-L174).

Browsing begins only when the shared discovery dialog requests it. Updates,
goodbyes and TTL expiration update its candidates; closing the dialog cancels
the browse. Finding a printer never saves it or selects a print target.
Explicit Add LAN connection locally adopts the candidate into the existing
Device catalogue without authentication, probing or control calls. This uses
the existing Moonraker HTTP route, not a claim of MQTT/PIN authentication.
Adoption validates expiry, host, identity and endpoint and derives capabilities
locally. It persists stable reported identity separately from configured model
association. Repeated adoption deduplicates by serial or an existing manual
endpoint, preserving that entry's ID, name, credentials and any configured model
or Console URL; absent model and blank Console URL receive discovery defaults
during explicit adoption. Subsequent configuration editing can still clear them.
Electron multicast/IPC/device-list fixtures and Web manual-configuration tests
cover software behavior. Physical U1 discovery and other desktop platforms
remain unqualified. No new mobile interaction is added; static/mobile Web
retains manual connection subject to its existing networking limits.

Model association remains optional, following the current Device configuration
contract. A user can save a connection and access supported device information
before associating a U1 profile. Do not require activating that profile merely
to save the connection. An absent association is not proof of compatibility:
submission must still validate protocol support and the retained slice's
requirements. Model filtering follows the existing priority: an explicit
configured association takes precedence, otherwise use the provider-reported
model. Do not add a separate configured/observed identity-conflict submission
block. Preserve the configured association; device reports do not silently
replace it.

The delivered model association and native device-model filter supply device
selection, not observed hardware. A configured U1 does not establish its
installed nozzle diameters, flow variants, filament presence or readiness.
See the [configuration model](../packages/printer-control/src/configuration.ts),
[device model filter](../packages/slicer-app/src/components/device/usePrinterCatalogue.ts)
and [native matcher](../packages/slicer-wasm/src/bridge_profiles.cpp).

Do not gate the whole connection or its operations behind a minimum firmware
version. Resolve support and availability per function through the shared
capability contract. Confirmed lack of an optional function disables that
function's entry; missing required capabilities block the operation that needs
them, including Send & Print material mapping. Upload-only keeps its separate
requirements. Unknown support remains unknown, and a version number alone does
not establish support. Parameter choices and limits belong to each normalized
function description rather than a vendor-wide assumed range. These capability
rules do not change command-failure semantics or authorize skipping a failed
preparation command and starting anyway.

The selected implementation is a TypeScript agent using host-injected transport
and the existing shared printer domain, with reusable Moonraker protocol code.
It does not require a Python slicing-pipeline runtime or a second vendor-specific
application UI. Both Electron and static Web are selected, sharing agent logic
through host-injected transport. Web uses direct printer access subject to CORS,
mixed-content and local-network permission restrictions; this delivery adds no
gateway. Host-specific execution and networking require separate validation.
Snapmaker-specific object names, firmware commands, numbering, normalization
and compatibility decisions belong to the agent; renderer code consumes
normalized capabilities, resources, options and diagnostics. Ordinary Moonraker
keeps its current on-demand policy.

#### Slice requirements and physical tool bindings

Keep these three identities distinct:

| Identity | Meaning in the U1 design |
| --- | --- |
| Project filament | Logical material slot; zero-based filament ID in the inspected non-Bambu `Tn` and U1 temperature commands. |
| Slicing tool | Parameter selection resolved through plate `filament_map`; its serialized values are one-based and the receipt's `toolIndex` is zero-based. |
| Device toolhead | Physical U1 head selected by the firmware mapping; protocol indices are normalized by the agent. |

Project filament count can be independent of physical head count while U1 keeps
`single_extruder_multi_material=false`. Setting it to true merely to expose UI
would also change extrusion-state semantics. Count handling and mapping
eligibility in the UI/native bridge need deliberate changes; this investigation
does not establish a need to redesign geometric slicing or G-code generation.
The accepted extension applies only to U1 profiles in this delivery and remains
available offline. Project slots retain the 1–64 range. The firmware's inspected
32-slot logical address space is enforced at submission through ID/metadata
validation, not by shrinking the project rack; unrepresentable submissions
block rather than becoming overridable hardware warnings. The
[project specification](Multi-Filament%20Support.md#148-u1-independent-project-filaments)
owns rack and manual-mapping eligibility. Other fixed multi-extruder models and
automatic grouping retain their existing eligibility rules.

Plate mapping participates in slicing configuration: it can change nozzle,
offset, flow-variant and extrusion parameters and invalidates affected results.
It is not a send-only preference. Reuse the plate editor and derive default
send bindings from the retained result's material requirements and `toolIndex`,
rather than from a subsequently edited live plate. Opening preparation preserves
that default instead of automatically rematching by loaded material or color.
Automatic matching is an explicit user action. Device refresh preserves manual
choices and updates diagnostics without silently assigning another head.
For example, logical F5 can use slicing tool 2 (the third tool), still emit
`T5`, and be sent with a firmware binding F5 to physical H2.
See [plate mapping](../packages/slicer-wasm/src/bridge_nozzle_mapping.cpp),
[material requirements](../packages/slicer-wasm/src/bridge_print_submission.cpp)
and [tool command generation](../packages/slicer-wasm/cpp/src/libslic3r/GCodeWriter.cpp).

The firmware send map is separate from the slicer's `physical_extruder_map`.
That internal field participates in temperature preheat addressing; populating
it with a U1 send-time permutation can change heater addresses while `Tn`
continues to use logical filament IDs. Do not treat the two fields as aliases.
See [G-code postprocessing](../packages/slicer-wasm/cpp/src/libslic3r/GCode/GCodeProcessor.cpp).

Send-time reassignment does not regenerate toolpaths or extrusion parameters.
The accepted Snapmaker policy validates and reports differences but allows
explicitly acknowledged manual material substitutions across material families,
known nozzle-diameter/flow-type/hardness conflicts, and missing values for those
hardware attributes. Automatic material matching stays within supported material
families; the agent owns normalization and family classification. Unknown
hardware values remain unknown rather than being filled from slicing presets
and presented as device observations. User acknowledgement accepts execution of
the original artifact; it does not establish compatibility or adapt the toolpaths.
Actually changing the generated parameters requires editing the project/plate
and re-slicing. The
[interaction rules](Printer%20Console%20and%20Control%20Integration.md#accepted-snapmaker-mapping-and-compatibility)
own the confirmation behavior.

These overrides concern material/hardware advisories, not invalid protocol
addresses, stale slice receipts or a successful command's unknown outcome.
Each newly opened preparation dialog starts from the retained slice's plate
mapping; temporary send bindings are not persisted as the next dialog's defaults.
The Bambu fixed-tool and compatibility rules in section 2.4 remain
unchanged; the shared contract must distinguish each agent's mapping capability
and diagnostic severity rather than imposing one provider's policy on all others.

U1 firmware accepts multiple logical IDs mapped to one physical head. It skips
mechanical switching if that head is already active, but the original logical
temperature, retraction, macro and tower instructions remain. All aliased
materials use the physically loaded filament. Preheating one logical material
can affect the shared heater while another logical material is printing.
This is a source-derived consequence, not physical qualification. Neo allows
many-to-one bindings, explains the shared physical filament and requires
confirmation of differing-temperature/shared-heater conflicts. It preserves
the original logical instructions; no automatic merging of materials,
elimination of redundant tool-change sequences or heater scheduling rewrite
is part of this policy.

#### Submission and device capabilities

The selected submission path validates one retained slice result and exports
its G-code. Upload-only transfers the file without applying submission mapping
or print options and without starting a print. Send & Print uploads without
auto-start, awaits successful transfer, applies mapping/options and dispatches
start only after successful preparation responses. An upload failure does not
apply those job settings. The agent transmits the exported G-code unchanged and does not
inspect its contents for preparation inputs or conflicting startup commands.
The current [submission capability](../packages/platform-contract/src/printer/printer.ts)
only names `print-3mf`, and the
[preparation controller](../packages/slicer-app/src/components/send/usePrintPreparation.ts)
exports a print/configuration package. Extend this single contract to select
artifacts by capability, using the existing receipt-checked G-code export for
U1; do not fabricate a Bambu package or introduce a parallel submission API.
Only a current valid Neo slice result is accepted for submission in this
delivery. Do not expose remote-file start or history-based reprint for the
Snapmaker agent. Repeating a print may re-submit that valid slice through the
normal preparation flow; upload-only does not persist a prepared remote-file
binding or create a later-start workflow. Remote printer file browsing/management
remains deferred within SnapSend. The [read-only Storage follow-up](#read-only-u1-storage-follow-up)
covers lists and thumbnails separately. Timelapse recording options and
submission remain included in SnapSend. The
[Snapmaker camera follow-up](#82-snapmaker-u1-lan-live-view) owns live view.

The accepted delivery covers the SnapSend scope and explicit deferrals in the
[interaction specification](Printer%20Console%20and%20Control%20Integration.md#accepted-snapmaker-delivery-and-connection).
Implementation may proceed in increments; a basic upload/print increment alone
does not complete that scope. Required capability families include:

- Fresh status, firmware, tools/nozzles and filament observations; distinct
  empty, inserted and loaded material states.
- Material mapping, bed leveling, timelapse and flow calibration per selected
  used head. Current scalar print options need a coherent extension for head
  selections.
- Device filament metadata editing and individual toolhead loading/unloading
  with progress. Each load/unload targets one physical head, with at most one
  such operation active per printer. Do not add a multi-head batch or a queue
  that starts later heads automatically; another operation requires a new user
  action after the current one finishes. Load/unload cancellation is outside
  this delivery; closing an observer does not cancel the device action.
- Device-page top-cover status, current-mode display and live fan speed control,
  plus firmware-supported detection, auto-refill and lighting preferences.
  Automatic mode derivation and job-specific top-cover preparation are deferred.

For the retained Device load/unload, filament metadata, preference-save and
top-cover fan commands, execution admission belongs to the printer. Do not
derive a local rejection or disabled state solely from observed idle, printing,
paused or busy state, or from a predicted conflict with another device activity.
Do not require a preflight readiness query for that purpose. Dispatch a valid
supported request and preserve the device's response. Target/parameter validity,
capability support, the individual load/unload contract and preference-save
readback remain in force. This policy does not replace submission validation or
broaden another provider's device-control behavior.

Device command errors and preference verification failures are reported without
automatic retry or compensating rollback. Keep editable user intent available
for another explicit operation, retain device changes already applied and
preserve actual response/execution evidence. A lost response is not proof of
non-execution. Preference-save readback remains required, and a mismatch or failed
verification cannot produce a verified-save result. Do not introduce a separate
automatic recovery sequence for these operations.

Per-submission intent, locally remembered user choices and persistent device
preferences have different owners. Device preferences must not be represented
as if a local preference write changed the printer. Neo remembers the three
print-option switches per physical printer. The flow-calibration head subset
belongs to one preparation session, uses deduplicated physical heads from the
current mapping and follows the defaults and mapping-edit rules in the
[accepted interaction contract](Printer%20Console%20and%20Control%20Integration.md#accepted-snapmaker-print-options-and-material-readiness).
The typed `preferences` observation and `preferences.set` command own persistent
Device edits. The U1 agent maps visual detection to `DEFECT_DETECTION_CONFIG`,
and refill, lighting and filament-motion detection to `SET_PRINT_PREFERENCES`.
The latter detection uses the firmware's `filament_entangle_*` fields (feed-wheel
motion versus requested extrusion), not camera-based visual detection. Visual
sensitivity offers low/high; filament-motion sensitivity offers low/medium/high.
Only reported fields with the corresponding command are editable.
An independent device-preference Save reads current values, writes changed
fields only and verifies them by readback; canceling preparation does not roll
back that save. Upload-only does not apply the current job's mapping/options.
For Send & Print preparation, await successful command responses for the
mapping and selected print options without an additional field-by-field device
readback comparison. An explicit preparation-command failure prevents automatic
print start. This acknowledgement policy does not weaken independent preference
Save readback, receipt validation or structured request validation.

If a later preparation command fails after earlier settings succeeded, stop
without print start and retain the already applied device settings. Do not
implement automatic rollback, a pre-write rollback snapshot or compensating
settings writes. Report partial application without claiming transactional
restoration.

For submission errors, including interruption after possible start dispatch,
use the generic failure/manual-retry interaction in the
[submission contract](Printer%20Console%20and%20Control%20Integration.md#accepted-snapmaker-submission-order-and-failure-behavior).
Retain uncertain execution evidence in the operation record even though the
UI uses the generic failure presentation. Reconnection must not replay an
operation. A user-requested Retry creates a new submission through the complete
validated upload/preparation/start flow with a current valid slice; it is not
an automatic retry, a replay of the old request identity or a start-only remote
file operation. No separate user proof-of-non-start or additional confirmation
workflow is required. Existing Bambu and Moonraker policies remain unchanged.

Submission cancellation is an explicit operation, distinct from closing its UI
observer. Before start dispatch, attempt to abort active upload transport and
gate each subsequent preparation/start stage on cancellation. If a preparation
request is already in flight, its effects may remain; check cancellation before
dispatching another command. Do not roll back applied settings or automatically
delete complete or partial remote files on failure/cancellation.

After start dispatch, submission cancellation does not imply non-execution and
must not issue a print-stop command. Device print-stop is a separate user request.
A cancellation/dispatch race preserves the actual execution evidence and follows
the accepted submission result/failure presentation, without falsely reporting
that printing was prevented. Device-managed temporary-file cleanup is outside
the agent's guarantee.

The agent must preserve the distinction between explicitly observed inserted
and loaded filament. Inserted-but-unloaded material is eligible for Send &
Print with a visible automatic-loading indication. The supported U1 startup
workflow owns loading; validate that firmware/profile contract rather than
manufacturing a loaded observation or unconditionally issuing a separate load
operation before submission.

Preparation currently assumes observation watching; the extension must honor
each agent's advertised delivery modes. Snapmaker uses the shared default
Monitor lifetime, retaining observation for the selected printer after the
Monitor starts, including while its page is hidden. Selection replacement,
connection removal or host teardown releases that subscription. Send consumers
and unfinished upload/device operations retain independent acquisition leases.
The implemented U1 acquisition hub shares concurrent reads and uses a two-second
normal poll interval. Failed reads mark retained snapshots stale; recovery stops
after three consecutive failures with exponential delay. Explicit Refresh or a
new consumer restarts acquisition without replaying commands.
Share acquisition when consumers need the same printer, and release
ordinary acquisition when none remain; a running physical print alone does not
require an application-lifetime monitor. Retain the last snapshot with its
actual observation time and non-live state. These internal lifetimes do not
introduce a public connect/disconnect prerequisite for stateless agent calls.

While observation is required, use bounded automatic reconnection with backoff
and expose manual retry after exhaustion as well as during recovery. Reacquire
state before enabling actions that require current observations. Preserve
manual mappings and unsaved edits across reconnect, and revalidate their
compatibility and availability. Reconnection restores observations only; it
must not replay mutations or automatically start a job. Observation ownership
does not cancel an independently submitted operation when a view closes.
The
[interaction contract](Printer%20Console%20and%20Control%20Integration.md#accepted-snapmaker-control-placement-and-status-observation)
owns control placement and visible freshness/recovery behavior. Snapmaker sends
also participate in the shared application-exit contract above.

The accepted Snapmaker submission boundary prohibits G-code scanning, parsing,
rewriting and command insertion, including SnapSend's legacy cancellation
insertion. Preparation consumes structured retained-slice
metadata and device observations. Do not detect conflicts with startup G-code
or impose a re-slice requirement for them. Assume the file needs no conflict
handling, issue selected device settings normally and execute the original
file as written. This policy governs the Snapmaker send workflow; it does not
replace the slicer's existing G-code generation or preview facilities.

The retained top-cover capability uses agent-normalized device state and direct
fan-control commands. It displays the existing circulation mode rather than
computing or manually selecting one for a job. No new `chamber_cooling_mode`
calculation or supporting high-temperature filament field is required by this
delivery. The
[interaction contract](Printer%20Console%20and%20Control%20Integration.md#accepted-snapmaker-g-code-and-top-cover-boundaries)
owns these accepted scope limits.

#### Independently accepted implementation units

The dependency order and acceptance boundaries below own this feature's
implementation plan. Each unit is validated and committed before starting the
next; final host acceptance checks their composition.

| Unit | Delivered responsibility | Independent acceptance |
| --- | --- | --- |
| 1. Protocol encoder | Structured logical IDs, physical bindings, used heads and job options. | Sparse IDs, range rejection, many-to-one maps, deduplicated subsets and exact command payloads. |
| 2. Provider entry | Manual Snapmaker registration, both host transports, optional model and normalized inventory. | Configuration persistence, provider isolation, absent readings and host setup. |
| 3. U1 project contract | Offline 1–64 rack, manual plate mapping, unchanged SEMM and logical numbering. | Dual-WASM real slicing, invalidation, history and roundtrip. |
| 4. Preparation | Retained-slice mapping, explicit matching, diagnostics, confirmation and calibration choices. | Structured requirements, matching/override rules and shared UI tests. |
| 5. Submission | Unchanged upload, preparation, start, cancellation and explicit fresh retry. | Injected failures at each stage, admission/cancel races, opaque bytes and host-owned state. |
| 6a. Device controls | Physical addressing, individual load/unload, hardware readings and metadata editing. | All four feed channels, one local material operation, parameter validation and retained operation ownership. |
| 6b. Persistent preferences | Independent changed-field Save and readback. | Supported choices, stale/current comparison, partial application, mismatch and draft retention. |
| 7. Observation lifetime | Shared consumers, independent operation leases, stale cache and bounded reconnect. | Concurrent consumers, hidden/reopened Device, last-consumer release and manual recovery. |
| 8. Exit protection | All-provider send registry, pre-admission artifact leases and host shutdown. | Return/stop decisions, late admission, lost observers, native callback joining and no physical stop. |
| 9. Integration | Shared capability-driven metadata editor, package exports and final documentation. | Workspace typechecks, affected packages, Electron/Web HTTP fixtures and existing Bambu/Moonraker regressions. |

#### Reference evidence and qualification limits

Real U1 firmware `2.0.0.205_20260914173503` exposed a command-discovery
correction: the `gcode` object's `commands` map lists registered commands even
without a help description; `/printer/gcode/help` does not. Acquisition queries
that map alongside device status, without probing commands by execution. The
[non-printing LAN acceptance](Printer%20Console%20and%20Control%20Integration.md#real-u1-non-printing-acceptance-2026-11-06)
records observations, preparation-only mappings, restored settings/fans and
unchanged upload verification; no physical print behavior is inferred.


The provider-private [U1 preparation encoder](../packages/printer-control/src/snapmaker/protocol.ts)
implements structured logical-material bindings, physical-head deduplication,
protocol index validation and print-option command construction. Its protocol
fixtures cover sparse IDs and many-to-one bindings; no file inspection is used.
The [Moonraker entry](../packages/printer-control/src/service.ts) and
[Snapmaker entry](../packages/printer-control/src/snapmaker/service.ts) register
distinct routes in both hosts. They reuse [HTTP service assembly](../packages/printer-control/src/http-service.ts)
for configuration management, uploads and operation records, with one
[configuration coordinator](../packages/printer-control/src/http-configuration.ts)
per host repository serializing reads and writes across both providers.
Operations and request identities remain provider-owned. Snapmaker owns U1
capabilities, state projection, command dispatch, observation leases and prepared
submission assembly. Device state follows configuration-generation identity,
while prepared submissions follow the host repository across fresh service
facades. The manual Device form can save
and reopen Snapmaker connections without a model or network probe. On-demand
[U1 inventory normalization](../packages/printer-control/src/snapmaker/observation.ts)
keeps inserted, empty and unknown material observations distinct from the
motion sensor's loaded state. Unreported hardware is not filled from presets.
Prepared submission uploads unchanged G-code before applying the structured
map/options and requesting start. Remote-file start remains intentionally
unavailable for Snapmaker. These implementations do not qualify physical
firmware execution. With a manually associated model, the Snapmaker agent
publishes Confirm-only `materials.configure` targets with each physical head's
nozzle context, reusing the existing Material information dialog and native
device catalogue. Native catalogue lookup matches the exact printer variant,
so a mixed-diameter U1 variant does not make a uniform variant ambiguous.
Confirm translates the selected canonical preset name's vendor/type/series to
the existing metadata command, with no calibration or Reset command. Local
rejection retains the dialog; later operation feedback belongs to Monitor as
in the shared editor. Without a model association, `materials.writeMetadata`
retains direct brand/type/color editing without a fabricated preset; device
rejection retains that draft. Official-filament restrictions are not bypassed
with `FORCE` in either path.
U1 print status normalizes the current and total layer counts from
`print_stats.info`. Its stage comes from the advertised
`machine_state_manager` main-state/action codes, using the firmware's action
labels and main-state fallback. Idle action/state reports a known null stage.
Missing or invalid layer/state data stays unknown. These observations also
describe completed jobs while the firmware retains their layer information.

The Snapmaker agent reads the current task's embedded thumbnail from file
metadata and the printer's authenticated HTTP file endpoint. It selects the
largest reported image and delivers its PNG/JPEG bytes through the shared
current-task media boundary. Task identity includes the filename, history job
ID, print start time and file UUID. A fresh identity read after image transfer
and a configuration-generation check reject results from a changed task or
connection. The same identity guards current-task cancellation. Missing images
or unavailable task identity leave the shared Monitor placeholder visible and
do not block observations or controls. This capability is independent of
Storage browsing and live-camera playback.

The Snapmaker agent estimates remaining print seconds with Snapmaker Orca's
executable-byte progress formula. It reads `estimated_time`, `gcode_start_byte`
and `gcode_end_byte` from Moonraker file metadata, then multiplies the estimate
by the remaining fraction of that byte range and truncates to whole seconds.
Valid metadata is reused during printing, pauses and retained terminal jobs.
A changed filename, a new active job after an observed terminal/idle state,
lower total duration or connection configuration change invalidates it.
Missing/invalid metadata, unavailable byte positions and
preparation before the executable range report unknown. Later observations retry
metadata failures while other status readings remain available. Completion
reports zero seconds. The calculation consumes server metadata, with the slicer
time estimate as its timing basis throughout the job.

Monitor material cards display normalized `materialType` consistently across
agents. The material editor displays the matched preset's name. Snapmaker uses
the reported vendor/type/series as input to exact system-name matching, which
returns a library filament identity
independently of the project's selected Printer; the device editor resolves
that identity within its own compatible catalogue. Project-side import still
validates the target model and material compatibility before applying changes.
In particular, the inspected firmware's calibration-subset
handler references both `flow_calibrate_extruders` and `flow_calib_extruders`;
successful subset execution needs firmware qualification rather than assuming
that a well-formed request proves the device applied it.

The comparison distinguishes three separate implementations:

- Upstream Orca's [Snapmaker agent](../packages/slicer-wasm/cpp/src/slic3r/Utils/SnapmakerPrinterAgent.cpp)
  extends [Moonraker](../packages/slicer-wasm/cpp/src/slic3r/Utils/MoonrakerPrinterAgent.cpp)
  with Snapmaker filament reads; this is not the full SnapSend preparation UI.
- [SnapSend 0.9.58](https://cloud.orcaslicer.com/p/51b695a195de) is a slicing-pipeline
  plugin. Its public description documents preparation, mapping, material
  operations and preferences, while Orca performs upload/start. Plugin source
  was not obtained; claims about it are documented behavior, not code verification.
- Snapmaker Orca was inspected at
  [v2.4.1](https://github.com/Snapmaker/OrcaSlicer/tree/bac6fd5c1e1c23ddf057cf6471ba4ed7ed621c4c),
  with [U1 profiles](https://github.com/Snapmaker/snapmaker-profiles/tree/1e201f6aa8920b4878daa02a21d43073ba92c06c)
  and [U1 firmware](https://github.com/Snapmaker/u1-klipper/tree/7ac453b50fe6779b2ec0b759038a17da5e6d671d).
  Firmware [mapping/preferences](https://github.com/Snapmaker/u1-klipper/blob/7ac453b50fe6779b2ec0b759038a17da5e6d671d/klippy/extras/print_task_config.py)
  and [tool/temperature addressing](https://github.com/Snapmaker/u1-klipper/blob/7ac453b50fe6779b2ec0b759038a17da5e6d671d/klippy/kinematics/extruder.py)
  establish the logical-to-physical protocol. They do not prove that every
  compiled sender accepts every possible mapping without further checks.

The official [V2.4.1 Windows portable release](https://github.com/Snapmaker/OrcaSlicer/releases/tag/v2.4.1)
contains a different Flutter web bundle from the repository tag. Static
inspection of its `resources/web/flutter_web/main.dart.js` (web build
`20261023182959`) establishes that send-only returns after file transfer,
skipping mapping/print-option application and print start. Its preprint UI has
a flow-calibration switch without an explicit head-subset payload. SnapSend's
documented upload-only action does apply settings, and its calibration UI
allows a subset of used heads. These are distinct reference behaviors; the
accepted Neo interaction contract above owns the choices. Inspection of
compiled JavaScript is not original Dart source or runtime/hardware validation.

The Neo baseline is main `b981adbf`, with Orca submodule `9ac76bf`.
Offline real-WASM exports established logical `T0`/`T5` and logical temperature
addresses with six project filaments, four nozzle parameter entries, SEMM false,
and both no tower and the default U1 Type2 tower. The slots were constructed
through a test entry point; this does not establish current UI support.
A separate nonidentity `physical_extruder_map` probe established the preheat
addressing distinction. These checks do not qualify mixed nozzles, all custom
macros/tower modes, the Snapmaker compiled sender or physical printing.

Implementation can be delivered and marked complete after automated acceptance
of the full selected scope, including protocol fixtures, the affected Electron
and Web boundaries and real-WASM checks for changed native contracts. Follow
the [testing guidelines](../doc/testing_guidelines.md) for scope and execution
levels. The
[acceptance contract](Printer%20Console%20and%20Control%20Integration.md#snapmaker-acceptance-and-physical-qualification)
owns the required software cases and independent real-U1 checklist.
Real printing, firmware behavior and shared-heater effects remain unverified
until corresponding physical cases pass. Missing hardware evidence does not
block software delivery, and mock/host/slicing evidence must not be promoted to
a physical or broader firmware/platform claim. Record firmware, profile and
host conditions when physical evidence becomes available. The roadmap records software delivery separately from this physical
qualification boundary.

#### Read-only U1 Storage follow-up

The [U1 Storage adapter](../packages/printer-control/src/snapmaker/storage.ts)
uses the configured Moonraker HTTP route and its existing authentication.
A single `GET /server/files/list?root=gcodes` on Storage entry or refresh
populates a bounded snapshot for both collections. A leading `.udisk/` path
segment identifies USB G-code. The firmware listing supplies file presence;
USB mount state remains unknown when the list has no USB G-code entries.
The adapter retains up to four five-minute snapshots and accepts up to 20,000
entries per listing.
Local cursors bind pages to the snapshot, storage and page size. File references
bind previews to the printer, route, configuration revision, storage and file
path.

The adapter shares thumbnail metadata, relative-path validation and authenticated
PNG/JPEG reads with the Monitor current-task image. Visible cards enumerate
preview options and receive a self-contained image through the existing
file-preview media contract. Route revisions and cancellation guard late
responses. Electron uses the existing renderer-to-main HTTP transport. Browser
access depends on the deployed origin, CORS and local-network permissions.
Fixture coverage exercises both host paths, including populated USB collections
and pagination.

On 2026-11-09, read-only internal Storage acceptance passed against stock U1
firmware `2.0.0.205_20260914173503` and Moonraker `2.0.0` on macOS ARM64.
Electron `43.4.0` used the normal IPC route. Chrome `156.0.8078.81` used direct
HTTP from `http://127.0.0.1:4173` with browser security enabled. Both used the
saved LAN connection with an empty API key. Each listed 13 internal G-code
files, decoded three sampled 300 × 300 thumbnails, exercised filename filtering,
and recovered from an injected listing failure via Retry against the same U1.
Request auditing confirmed entry-only discovery, snapshot reuse during storage
switching, a fresh listing on refresh and re-entry, and GET-only device requests.
The USB scope displayed the expected no-files status. A populated USB drive,
large physical libraries and a deployed HTTPS browser origin remain unqualified.

#### U1 stored timelapse follow-up

The [timelapse adapter](../packages/printer-control/src/snapmaker/timelapse.ts)
reads one page of up to 20 records when the user opens the internal Timelapse
collection. It uses `camera.get_timelapse_instance` over the configured
Moonraker WebSocket and closes the socket after each page. Cursor scope includes
the route configuration and page size. The firmware supplies best-effort
pagination. Video and optional cover suffixes resolve inside the configured
printer's `/server/files/camera/` root. Cover reads use the existing thumbnail
contract.

Web uses the browser video element and the printer's direct HTTP media endpoint.
The browser lists videos on API-key routes and offers playback on routes that
can serve media without the key. Electron issues a temporary document-owned
video URL under the shared `orca-printer-media:` scheme through validated IPC.
Development and production use the same media policy for the scheme. The U1
adapter validates grants, forwards single HTTP range requests and attaches saved
credentials in main. The URL is retired on
close, document navigation or configuration change. Video bytes stream into the
player without a full-file staging step.

On 2026-11-09 a stock U1 on firmware `2.0.0.205_20260914173503` completed a
10 × 10 × 3 mm single-head PLA block through Neo Send & Print. Firmware reported
Timelapse enabled during the task, 15/15 layers, full progress and zero targets
for all five heaters at completion. The device recorded 545.14 seconds total
and generated a 777,007-byte MP4 and JPEG cover for that job. The MP4 route
returned HTTP 206 for a requested range. The
[opt-in print harness](../apps/desktop/e2e/snapmaker-print-hardware.e2e.ts)
can enable recording with `NEO_U1_ACCEPTANCE_TIMELAPSE=1`.

On macOS ARM64, Electron 43.4.0 and Chrome 156.0.8078.81 each displayed the new
entry and cover and decoded moving 1920 × 1080 video in the shared Storage
player. Chrome used `http://127.0.0.1:4173` with standard browser security.
The measured video duration was about 0.504 seconds. Both hosts used an empty
API key. Real API-key playback on Electron, deployed HTTPS Web and larger
physical video collections remain unqualified.

#### U1 file downloads and deletion

U1 downloads stream authenticated G-code and MP4 reads through the shared
download executor. Each file reference binds its storage and printer
configuration. The Electron host resolves saved routes again before queueing
and execution, then writes through the existing journaled filesystem sink.
The browser uses its own file or directory picker and streams into a
browser-granted writable handle. The U1 reader offers complete files.

G-code deletion uses the configured Moonraker file route and checks the
returned action, root and path before recording completion. Both hosts use
the shared operation tracker and confirmation dialog. Timelapse deletion
uses a single recording's timestamp index over the camera WebSocket.
Interrupted or ambiguous deletion responses leave the outcome unconfirmed.
Protocol references are the [U1 Moonraker file handler](https://github.com/Snapmaker/u1-moonraker/blob/ed7b3752a9a938c87ee086f3b7b21a9352a2a0c9/moonraker/components/application.py)
and the [U1 camera endpoint registration](https://github.com/Snapmaker/u1-moonraker/blob/ed7b3752a9a938c87ee086f3b7b21a9352a2a0c9/moonraker/components/repeater.py).
Loopback Electron and Web fixtures cover these actions without mutating a
physical printer.

On 2026-11-10 the development-host LAN round used stock U1 with Moonraker
2.0.0, Electron 43.4.0 and Chrome 156.0.8078.81 on macOS ARM64. Both hosts
saved a newly uploaded internal G-code file, matched its SHA-256, confirmed
deletion and verified that the exact file disappeared. U1 returned gzip for
the G-code reads. The reader streams Fetch's decoded bytes and excludes the
encoded wire length from file-size validation.

Both hosts used **Save as…** to save the 777,007-byte recording from the prior
Neo print. The two saved copies matched an independent archive by SHA-256.
Electron confirmed deletion of that test recording. Chrome showed the empty
collection after refresh, and the device returned HTTP 404 for its asset.
The run used an isolated Electron save destination and a browser-private file
handle in place of manual picker selection. The printer reported zero USB
G-code files. USB file actions and Web-initiated recording deletion retain
fixture coverage. No print was started in this round.

## 3. Identity, configuration and stateless access

Separate printer identity from its routes, provider, configured printer type
and execution host. One printer may have several routes. Names, addresses and
list positions are not stable identities or sufficient evidence to merge devices.

All public APIs are stateless: a request supplies its printer/route target or a
fully scoped resource reference, parameters and any relevant comparison
conditions. No public connect/disconnect lifecycle, initialized client object,
connection epoch or prior capability query grants access to another operation.
The authority resolves saved configuration and credential references for each
request. Configuration, device state, caches, operation records and explicit
resources may persist; statelessness does not prohibit those resources.

Agents may internally maintain protocol connections, authentication, caches or
connection pools. These are implementation details, not client preconditions.
Per-function behavior may combine local resolution, request-based operations
and explicitly requested observation. Do not force all functions of one agent
into a single connection mode or emulate requests with hidden public sessions.

Manual addition and route editing are local configuration operations, separate
from discovery. The user can choose a printer type and IP/address and save an
unreachable printer. Addresses can include protocol, port and proxy path as
needed; a native Web address can differ from the API endpoint. Persist stable
configuration, not transient capability answers or media credentials. Validate
configuration locally, and advance its revision on changes. In-flight operations
retain their original configuration snapshot instead of silently retargeting.

Loading the application, listing types/saved printers and describing a configured
route must not probe, authenticate against or read from request-based printers.
The Bambu lifecycle in section 2.1 is an explicit exception for host-owned plugin
startup/connection, not for adding probes to local configuration methods. Startup
must not automatically discover capabilities or establish subscriptions for
request-based printers. Selecting Moonraker opens its configured Web interface
without an agent connection or preflight. Loading that page has its own network
traffic; it does not imply agent-owned control or inventory requests.

Public discovery is an explicit optional operation scoped to an execution host
and source such as LAN or an account. Bambu's host-owned Orca-compatible
lifecycle may also refresh account devices or maintain discovery; callers do
not need an initialization sequence to consume its public API. Candidates can
expire; adoption is a separate
configuration operation with self-contained candidate data, validated by the
provider rather than trusted as executable authority. Discovery is never a
prerequisite for manual addition. Saved entries remain visible when unreachable.
Adding or discovering a printer does not select it as a print target. Preserve
the independent console and send selections in the console specification.
Forgetting removes Neo configuration, not remote files, account bindings or jobs.

Discovery support is declared per provider execution host, alongside that host's
identity. Every supported entry supplies a non-empty set of scope kinds for that
host. Do not combine a provider-wide scope list with an unrelated host list:
support for LAN on one host and account discovery on another does not imply
either supports both. A provider with no hosts has no supported discovery
entry. Hosts used for manual configuration remain valid catalogue entries even
with unsupported or unknown discovery support. The caller selects a supported
host/scope pair; account-scoped discovery uses the selected provider's current
account internally. No account reference, connection or prior discovery call is
required from the caller to construct the request. The provider validates the
selected host, scope and required authentication internally, and prevents stale
results from crossing account transitions.

Subscriptions and long-running operations also have independent request
boundaries. A subscription explicitly names target/topics and an optional
resume cursor. Media calls name their delivery resource; operation queries name
their operation or request. These identifiers are not printer-control sessions.
Stopping a subscription does not cancel a print or release unrelated media.
Agents may share internal observations, but ownership/refcount policy is open.

### 3.1 Capabilities available from local configuration

Use one normal capability model for discovered candidates, saved-route
enumeration and direct description. Providers establish support from their
implemented functions, configured type, address/settings and applicable retained
observations. The UI must not infer support from a display name. Capability
projection is local and does not require validation through a device probe.

Support, operation constraints and present availability are distinct. Declaring
support requires a complete request description: applicable targets/destinations,
modes and required choices must be supplied. The entire constraints value is
never null. If the provider cannot yet describe how to construct the request,
report unknown rather than manufacturing resource IDs or a supported placeholder;
this does not authorize automatic probing. Unknown is not unsupported.
Type/configuration can completely determine a Web entry or default upload
destination, allowing direct use without any discovery call. Specific unknown
limits do not prevent this local support declaration.
Descriptions are advisory; operations independently validate actual parameters,
resources and supplied comparison conditions, obtaining only necessary data.
No full-device capability discovery or unrelated preflight is imposed.

The same capability source is scoped to a particular route, not unioned across
LAN/cloud alternatives. Current applicable device evidence can refine type
knowledge. A timeout, missing field or unsuccessful refresh is not proof of
unsupported functionality. Configuration changes invalidate dependent cached
facts, not facts about a different route. Cache retention/reconciliation details
remain implementation choices; stale data must not be relabeled freshly read.

Required modeling cases include:

- A Bambu type can declare meaningful control/monitoring support locally so its
  dedicated device interface is eligible without an initial connection. This
  does not declare every command, file or camera function supported.
- A limited Moonraker type declares native Web access and G-code upload locally.
  Web resolution is complete from configuration, not a waiting-for-connection
  placeholder. Upload need not imply listing or real-time monitoring support.
- A specific Klipper type such as Snapmaker U1 additionally declares on-demand
  material inventory reads. This is not a blanket claim about all Klipper types;
  concrete endpoints and device qualification remain agent implementation work.

An untested route is not automatically blocked. Clicking an available configured
function initiates its own operation and reports its own result. A request
failure must not globally disable independent Web or API functions.

## 4. Hardware, capabilities and operational availability

Printer properties cover stable identity and display name, manufacturer/model,
serial number and external identifiers when available, firmware information,
and build volume/geometry. Missing information remains explicit. These observed
device properties do not automatically replace the project's selected Printer
preset or its slicing configuration.

Hardware topology describes motion groups, tools, extruders, nozzles,
actuators, sensors, cameras and material-system relationships. These objects
have distinct identities. Do not equate a tool, extruder, nozzle, material slot
or array index. Allow multiple active tools and partial topology descriptions.
Nozzle diameter and construction material are hardware properties; neither
identifies the filament currently loaded through the nozzle.

Capabilities describe what the current route and adapter can expose, including
target resources, numeric ranges and supported modes. Support has three
states: supported, unsupported and unknown. An unsupported feature can arise
at the device, adapter or route boundary; retain the reason. Missing knowledge
must not be presented as confirmed lack of device support.

Required target/choice collections are non-empty when a capability is supported.
This applies to controllable resources, start-file sources/formats, writable
material fields, file scopes/formats/collision policies, camera transports/image
formats, observation delivery modes, special-action reference sources and
discovery scope kinds on each host.
Optional feature collections can be empty only with defined behavior: an empty
camera profile list means omit profile selection and let the adapter choose delivery; an empty
job-timelapse list means no optional job-level timelapse choices. Neither is an
unknown required-choice placeholder. Pause/resume/cancel have an explicit empty
constraint object and empty parameters: the request identifies the printer and
route, and these controls act on its current print. They do not require a job
selector or an earlier observation.

Only specific documented limit fields may be null: upload size, concurrent
viewer count, and individual numeric-range bounds/granularity can be unknown.
Keep their containing descriptors and resource IDs present. Null does not mean
unlimited, safe, zero or a provider-selected numeric default. Callers can check
known bounds, but must not invent slider bounds or step values for unknown ones.
Intrinsic parameter semantics still apply, such as finite numbers, appropriate
units and fraction bounds. Unrelated optional metadata keeps its own documented
absence semantics; this rule does not redefine all null values in the domain.

A capability supplies the operation description, not user content or live
selection: the caller still supplies its file, agent-issued action reference or
parameter values. Do not place current print state, live action references or
per-file inventory into capabilities to duplicate observations. Supported special
actions identify at least one supported observation source (status or alerts)
that can supply references. An empty current action collection is valid when
there is nothing to act on; it is not an incomplete capability description.
Execution validates requests regardless of prior description or client checks. Failure to read a new limit does not erase a still-valid earlier
request description; invalidate only facts that no longer apply to the route.

Operational availability is a separate, time-sensitive assessment. A supported
command may be blocked by authentication, offline state, an active job, resource
use or device restrictions. File-specific availability likewise does not create
a second capability declaration. UI availability is advisory; execution must
revalidate relevant conditions.

Keep command semantics, parameters, capability constraints and results
consistent across adapters. The earlier interface sketch proposed deriving
them from one command-specification map; mapped types or code generation are
implementation choices, not requirements. A generic raw JSON/G-code passthrough
is not part of the proposed common control surface. Any later vendor extension
needs explicit semantics and validation rather than bypassing the abstraction.

### 4.1 Native Web interface

The optional native Web interface is a semantic device capability with supported,
unsupported and unknown states. It identifies a named entry for the current
printer route, independently of Neo's monitoring, control and file capabilities.
The native page and Neo's own device pages may coexist. A printer that only
exposes a Web UI remains representable without inventing control support.

The [Web interface contract](../packages/platform-contract/src/printer/web-interface.ts)
provides service-scoped description and launch resolution. Neither requires a
successful printer-control connection. The description projects the same
route capability published by enumeration/description; it is not a second support
registry. Description is local-only and never performs a reachability probe. Cached descriptions retain their assessment time and stale marker.
A failed control connection alone proves neither absence nor unreachability
of the native Web interface.

Resolve the identified entry when opening it, rechecking the route and entry
identity and obtaining temporary authorization only if required by that provider.
Moonraker resolves from saved configuration with no control connection, device
request or capability probe. The caller need not describe the entry first;
an optional expected entry identity detects replacement. Launch data contains an
absolute HTTP(S) URL and any known expiry. A removed or replaced entry must not
silently redirect an old request to another interface. Ordinary configured
entry URLs may persist; temporary authorization and launch data do not belong
in persistent snapshots or logs. URL validation remains required at runtime.

The viewing host decides whether to embed the page or open it externally,
subject to actual host/page policies. A provider URL does not promise iframe
compatibility or reachability from the viewing host. If embedding fails and
external opening is available, offer that path without declaring printer API
control unsupported. Browser policy failures must remain distinguishable from
device capability support.

Web-page login and printer API authentication are separate. No generic API-key
injection, arbitrary headers or executable scripts are part of the launch
contract. Existing provider-specific console authentication remains governed
by the console specification. Its Moonraker Console URL fallback is not a
universal rule for other providers. This interface introduces no browser host,
page-opening implementation or credential migration.

### 4.2 Device page eligibility

The application derives page eligibility from semantic capabilities and the
viewing host environment. Agents do not supply page names, visibility flags,
tab order or default selection. The Device UI applies one application policy for
its Web Interface, Monitor and Storage tabs; other pages remain future work.
Locally established capabilities are sufficient for eligibility; no connected
snapshot is required. Eligibility does not authorize automatic device reads.
In particular, selecting a request-based printer must not start capability
probes or material synchronization. Unknown individual limits can be explained
locally or checked during the requested operation, without forcing a universal
connecting screen. A configured Moonraker Web entry opens normally.

| Page | Eligibility | Conditions that do not remove eligibility |
| --- | --- | --- |
| Monitor | At least one supported observation suitable for monitoring (status, thermal, motion, actuators, materials or sensors), camera viewing/snapshot capture, or basic control. A standalone material-import action is insufficient. | No active job, no camera, a temporarily unavailable camera, or readings not yet reported. |
| Storage | File listing is supported or explicitly unknown and resolvable on entry. Unknown support does not trigger a probe until Storage is opened. | An empty collection/directory, temporarily missing removable storage, or unavailable download/delete actions. |
| Warnings | Device alert observation is supported. | Zero current warnings or no unread warnings. |
| Firmware | Firmware version inventory observation is supported. | No available update, no upgrade capability, or an upgrade blocked during printing. |
| Web Interface | A native Web entry is known to be supported. | Missing Neo control capabilities, a failed control connection, or embedding being unavailable. |

Monitor cards and actions have their own capability and availability checks.
A passive probe or door sensor is sufficient useful monitoring; a camera is
not mandatory. Static identity/firmware metadata, Web access or alert support
alone does not establish Monitor eligibility. File-only actions, including
upload or starting a selected remote file, do not alone require a Monitor page.
Only upload support does not establish file-browser eligibility. A manual
material-import action alone need not create a Monitor page; its sync button
is available independently of monitoring or subscriptions. Observation delivery
mode and actual page functionality inform eligibility; the exact placement of
the sync control remains open.

Warnings are device observations, not a bucket for transport, login or other
application errors. An empty warning list yields an empty state; counts affect
badges rather than tab existence. Native-page errors and other failures remain
visible in the relevant surface.

Known support with temporarily blocked or unknown availability retains the page
and explains its state. Confirmed unsupported capability hides the page. When
support is initially unknown, expose that uncertainty without automatic probing;
do not label unknown as unsupported or briefly create every possible tab.
After a failed read, retain previously confirmed pages with relevant stale/error
indicators instead of making them disappear. No active subscription means
unobserved, not offline; never show a reconnecting state for a request-only agent.
An authoritative capability change can revise eligibility, but that is distinct from a failed read.

Cache decisions for the applicable printer, route and viewing-host environment.
Do not union LAN and cloud capabilities or reuse an Electron embedding decision
in Web. Supported Web entry access with no usable opening mode retains an
explanation rather than implying the printer lacks the entry. The exact tabs,
layout and initial selection are not fixed here; existing explicit printer
selection behavior is preserved. The initial Monitor exposes status, sensors,
heater targets and basic print controls; camera viewing and other monitor cards
remain future work.

For Snapmaker-agent printers, the Device UI orders Monitor before Web Interface
and opens Monitor by default when eligible, including remembered device
restoration. Users can still select Web Interface explicitly; choosing another
printer applies that printer's default again. Other agents retain their current
tab order and default selection.

### 4.3 Firmware observations

Firmware version reading is an observation capability, exposed through the
firmware topic and an independently addressed observation read. It does not add an upgrade
command or imply permission to check for updates or install firmware. Those
operations require separate capability and lifecycle design if implemented.
A version-only device can have a read-only Firmware page.

The descriptor's firmware inventory is the single source of component/version
data. It carries known/unknown and fresh/stale reading semantics, including
source and timestamps, instead of using an empty list to mean every possible
absence or failure. A firmware-topic read projects that same inventory without
requiring a complete descriptor read. Both projections share one cache/version
source; no duplicate list is added to printer state or a separate firmware service. Page eligibility follows read support, not list
length or update availability.

## 5. Read-only sensors and actuator separation

Provide a generic sensor collection in hardware topology and corresponding
readings in synchronized state. Each sensor has identity, display metadata,
a discriminating type and an explicit unit where applicable. Its type selects
the value shape: scalar temperature or humidity, door state, filament presence,
or structured values such as a vector. New sensor types must extend this model
without adding unrelated top-level state fields or weakening existing types.
Vectors and generic numeric/binary types are extensibility examples, not a
mandatory initial sensor catalogue. If generic types are used, stable semantic
identifiers distinguish their meaning; display names are not machine-readable
semantics. The extension mechanism itself is not fixed to a TypeScript map,
plugin registry or vendor payload format.

The sensors observation topic returns a self-contained snapshot of definitions,
readings and a definition revision. It must remain usable when full descriptor
reading is unsupported or no descriptor is cached. Each returned reading has
exactly one definition with the same sensor ID and kind; definition IDs and
reading IDs are unique within their respective collections. Generic sensor
definitions include their semantic identifier and unit, so consumers never have
to guess what a numeric value measures. Adapters validate these relationships;
the type declarations alone do not enforce cross-record consistency.

Definitions share one authoritative source with the descriptor's sensor
collection; the snapshot is a projection, not a second definition registry.
Static configuration or retained definitions can supply this projection without
an additional network request. The definition revision is scoped to the printer,
route and configuration, changes when definitions change, and remains stable
across measurement-only updates. Sensor-topic reads and replacement events
publish matching definitions and readings together. They do not require a prior
descriptor call, automatic hardware discovery or a control connection. If the
adapter cannot supply matching definitions, it must report unavailable data or
an explicit failure rather than publish uninterpretable readings as known.

Readings preserve known versus unknown, fresh versus stale, observation and
receipt times, and source route. Never use zero, false, an empty slot or a
closed door to stand in for an unknown reading. Lack of a device timestamp
must remain distinguishable from a locally observed receipt time.

A temperature sensor does not imply temperature control. A heater is an
actuator with a target temperature and optional reference to its reported
feedback temperature sensor in the proposed model. Keep one authoritative
reading when several views expose the same measurement; common sensor state
with references is the current proposal, not a ban on derived UI projections.
A read-only chamber probe therefore needs no chamber heater. A heater may
exist without an exposed feedback reading.
Several probes can observe a region; sharing a referenced reading must not
duplicate its identity or data.

Material units and dryers reference sensors for humidity, temperature or lid
state. Those measurements also live only in the common sensor collection.
Dryer phase and remaining time remain dryer operational state. Material-slot
presence remains a business observation that can be derived from several
sources; it need not correspond to a physical presence sensor.

Sensors expose no generic write command. Sensor configuration, if later needed,
requires a separate explicit capability. Door readings do not prescribe a
universal interlock: any blocking or automatic action belongs to device rules
and command availability. Validate that references resolve to the appropriate
sensor type, including heater references to temperature sensors.

## 6. Material systems and synchronization

Represent material units, slots, paths and dryers separately. A unit can be a
manual holder or automatic feeder. A path connects a material slot to a tool
and describes manual or automatic loading. Do not require four-slot units,
contiguous vendor numbering, one feeder, one nozzle or one active tool.

Separate physical presence, material metadata, spool identity and remaining
quantity. Metadata can include material type, manufacturer, filament diameter,
color and catalogue association when available. An empty slot can retain this
metadata; it is not evidence of filament presence. Preserve solid and
multi-color descriptions. Remaining
quantity includes a unit and whether it is measured, estimated or unspecified.
Vendor/catalogue references are namespaced and are not assumed to be Neo
filament preset identifiers.
An observed supply remains distinct from an eligible project-sync source.
Source eligibility requires a non-empty normalized material catalogue identity;
retained color or material type alone is insufficient. Presence is independent:
an identified supply may still have empty or unknown presence. Sync and the
installed-material dropdown share source conversion, native eligibility and
native matching, with their different fallback ranges owned by the
[Prepare synchronization rules](Printer%20Console%20and%20Control%20Integration.md#prepare-printer-and-filament-synchronization).

The accepted [Convenience Mode extension](Multi-Filament%20Support.md#147-convenience-mode-extension)
distinguishes raw observed supplies used as advisory native grouping inputs
from eligible project-import sources. Its native candidate rules must not be
implemented by weakening the existing Sync/picker eligibility contract. The
design also requires retaining a device-reported representative color separately
from a multi-color list. The feature specification accepts advisory reuse of
same-source stale metadata, existing-only pull acquisition, candidate withdrawal
after failed explicit pulls and native candidate filtering/relaxation/fallback.
These grouping policies do not relax project-import or command freshness rules.
The accepted design adds no slice-time hardware-sync prompt and covers existing
native-supported fixed-dual SEMM configurations, including mixed diameters and
flows. The contract extension and feature are implemented with software fixture
and LAN-only H2D read/group/local-slice acceptance. Physical printing remains
unqualified. The feature topic owner records the native, host and hardware-backed
read-only evidence.

Printer and material sync are shared application workflows that future agents
must be able to reuse. Normalized observations and independent capabilities
select the applicable workflow; provider/model identity does not select a
separate shared UI or project mutation implementation. Protocol encodings,
device aliases/numbering, catalogue normalization and vendor policy belong to
the agent. Native compatibility and reference transformations remain in their
existing owners. Preserve opaque IDs, arbitrary reported resource cardinality
within native limits, and both push-backed and explicit on-demand reads.
Project synchronization may reuse fresh, coherent cached observations for
topics maintained by push/poll delivery, without requiring another device
round trip. Cache provenance and required tool/nozzle/material references must
pass the same normalization as a device read; unrelated missing device
resources do not block synchronization. Missing or unusable cached data triggers
an explicit device read; on-demand-only sources and an explicit Refresh always
perform that read. Failed refreshes remain failures. This selection uses
observation capabilities rather than provider/model identity and does not
weaken the pre-commit source or project revision checks.
The [agent extensibility rules](Printer%20Console%20and%20Control%20Integration.md#agent-extensibility)
apply even though the initial runtime integration is Bambu only; they do not
authorize implementation of additional agents or a gateway.

Track selected and loaded paths independently, with loading, unloading,
switching and fault state. The selected next source is not necessarily the
material already loaded. Represent manual action or missing reporting honestly.
Loading, unloading, switching, writable metadata, tag refresh and drying are
independent capabilities with resource-specific constraints. Observation
support does not imply permission to modify material metadata.

Inventory synchronization updates the device model. It must not silently
rewrite the open project's native rack, presets, colors or assignments.
Import into the project is an explicit application workflow. The accepted
[Prepare synchronization design](Printer%20Console%20and%20Control%20Integration.md#prepare-printer-and-filament-synchronization)
uses one atomic native application, with Bambu as the initial device
integration. Clean empty projects import Filament directly after Sync; occupied
projects, modified active Filaments and necessary reference replacements retain
the modal mapping/rebuild review. It exposes empty slots, missing data
and unresolved preset matches, and follows existing native compatibility and
history rules. That UI specification owns the settled interaction and initial
capability-based Bambu coverage. A failed or stale proposal cannot partially
change the project. The shared import and initial Bambu normalization are
implemented; the domain does not imply support by an additional agent.

The current material contract carries `catalogRefs`, a list of namespaced
associations for the same material. Agents can supply `orca-filament` references
to native `filament_id` values while retaining their own catalogue identity.
Hardware model associations use `orca-printer-model`; agent-declared
`orca-compatible-printer-model` associations additionally permit Filament import
into a compatible project model. Printer sync resolves only the device's own
model. These are catalogue associations, not display-name equality or protocol
IDs interpreted by the shared UI. Nullable manufacturer/model descriptions
remain unknown; the same native model predicate handles them and the catalogue
associations for Printer sync, Filament sync and installed-material selection.
Nozzle `flowReporting` explicitly separates
supported, unsupported and unknown reporting; an absent value with unknown
support cannot silently select Standard.

Printer-hardware import uses the same application/native ownership boundary:
device observations do not mutate slicing presets or project nozzle/flow and
capacity inputs. The application explicitly captures a source and prepares the
validated request; native code resolves compatible presets and applies project
changes directly after the explicit Sync action and any necessary Orca-style
confirmations/configuration choices. There is no generic Printer before/after
preview dialog or Printer preview API. Filament import uses the direct or
conditional modal workflow described above.
Keep vendor protocol encodings and model/catalogue normalization in the agent,
and physical-device slot/tool identities separate from project rack/nozzle
identities. Hardware requests must also retain their source route/configuration,
relevant descriptor/topology context and native project revision for validation.

Every material import proposal retains the source observation snapshot's
configuration revision alongside its printer/route, topology, inventory and
project context. Capture this revision from the same snapshot as the inventory;
do not substitute the current route revision from a later lookup. Before any
project mutation, verify that the source route still exists and its configuration
revision matches the proposal. A mismatch invalidates the proposal even when
topology and inventory revision tokens happen to be equal. Reject stale input
without changing the project; preparing a replacement requires a new explicit
workflow using data from the applicable configuration. This comparison is local
and does not trigger an automatic device read, connection or material sync.

Project slot identity and physical device slot identity stay separate. Print
submission binds the printable artifact's material keys to actual material
paths, subject to the route's mapping capability. Do not derive this binding
from coincident array positions or assume that importing device inventory is
required before every print. The existing native rack, preference and
Undo/Redo contracts remain owned by the multi-filament specification.

For manually synchronized types, a materials-topic device read fetches inventory
once only when the user invokes sync. It returns the relevant material topology,
tool references and state with source, observation time and revisions, without
requiring unrelated hardware, firmware or a full printer snapshot. Cached reads
never initiate device I/O. Failure preserves previous cached inventory and its
age; an unavailable read is not an empty inventory. Do not start polling,
subscriptions or automatic reconnect afterward. Reading inventory is distinct
from commanding an RFID/tag refresh. A user-requested project sync may compose
this read with the explicit native import workflow above.

## 7. State synchronization and command outcomes

Synchronized information includes printer operational state, active tools,
print phase/name/progress and remaining-time estimates, actuator and motion
state, material inventory, camera state, sensor readings and alerts. The status
topic carries display information directly from the agent; it is not a registry
of tasks submitted by Neo. Each print field has its own known/unknown and
fresh/stale reading. Idle is distinct from an unknown phase, and a known absent
name is distinct from an unreported name. Terminal phases remain displayable
without a job identity or a source-file reference. Agents must not require
matching device telemetry to an application's upload/start operation before
publishing status, including prints started by another client.

Alerts retain identity, severity and a usable message. Contextual actions may
belong to an individual alert or to status, with one observation owner rather
than duplicated copies. Warnings and estimated values must not be promoted to
confirmed device facts.

Reads explicitly select cache or device access and the requested topics. Device
access performs only the requested one-shot read; it does not require a full
snapshot, prior evaluation or a persistent connection. Unknown and stale values
remain explicit, including failures in part of a multi-topic read. Transport
and authentication errors belong to the request/resource, not a global state
that gates all other APIs.

A successful read or subscription snapshot contains exactly the actual requested
topics, including explicit unknown readings for unavailable requested data.
An absent topic means it was not requested, not that its reading is unknown.
The type of a dynamic topic list describes possible members; it does not prove
that every possible member was requested. Public result types must not promise
all such fields exist. The current contract requires presence checks when more
than one topic is possible, while a single-topic request retains its required
field. Snapshot and replacement payloads are non-empty; replacements include
only changed topics within the subscription. Consumers of replacements must
not interpret absent topics as deletion or unknown readings.

The current event model uses snapshots scoped to requested topics followed by
ordered replacements. Resume cursors identify feed positions, not connections;
expired/inapplicable cursors or gaps require an explicit fresh snapshot before
further updates. Cursors are bound to the target, topics and configuration. Responses carry
configuration revisions so late data from edited routes can be rejected.
Adapters must publish mutually dependent data coherently and reject obsolete
references. Material reads therefore carry the relevant topology and inventory
together; sensor reads carry their definitions and readings together. No public
connection epoch is needed. Exact buffering and cache
implementation remain open. Vendor payloads are not the shared domain model.

Descriptor, topology, capability and inventory revisions have distinct
meanings in the proposed sketch. Their exact tokens and grouping are open;
control validation needs enough current context for the command's correctness,
without requiring every command to carry every revision. Client comparison
conditions are optional and operation-specific. Omitting them does not omit
execution-time safety/compatibility validation; supplying one requires an honest
comparison or explicit rejection. Evaluation is advisory and never a token or
prerequisite for submission. Reads and ordinary upload/start workflows must not
require first obtaining topology or inventory versions. Sensor
telemetry changes alone must not invalidate an unrelated material mapping.
Observations may be pushed, polled or obtained on demand, with support declared
per topic, including sensors. A subscription to an on-demand-only topic is
unsupported; it must not silently create a poller. Refresh does not promise that every reading
becomes known or fresh.

Basic controls include job start/pause/resume/cancel, temperature targets,
fans, lights, homing, jogging, extrusion and tool selection where supported.
Material and camera controls use the same typed command/outcome discipline.
Starting a print selects a remote printable file and applicable options; its
confirmed command result does not create a public job identity. Pause, resume
and cancel require only an explicit printer/route target and act on its current
print at execution time. They neither require history access nor promise to
target the print last shown in a view. Device readiness and rejection remain
execution-time concerns, independent of whether status has been read.

For context-specific actions, the agent publishes a display label, optional
description, availability, optional known expiry and an opaque action reference.
The reference carries printer, route and configuration provenance plus opaque
agent-issued data. Protocol-specific job IDs, error identifiers and command
parameters are encapsulated inside that context. Applications pass the reference
unchanged to the typed action-invocation command, without parsing it, supplying
raw vendor parameters, or linking it to a Neo-submitted print. General calibration
or coordinated modes still need their own semantics; this mechanism is not an
arbitrary protocol-command escape hatch.

Action submission works through an independent service reference without a
prior evaluate call, active observation stream or caller session. Each agent
must validate reference authenticity, target/configuration, permission, expiry
and current device context before acting. A target mismatch rejects as
invalid-target; an expired, revoked or obsolete context rejects as stale-context.
It must never silently retarget a different print or warning. Cached availability
and a null expiry are not authorization or validity guarantees. The agent must
not claim atomic context protection where its protocol cannot provide it; an
action requiring such protection must be unsupported or explicitly rejected.
The token may encapsulate validated data or identify an agent-owned resource;
its encoding, storage and retention are not prescribed, and it must not expose
credentials. A resource-backed reference is not a client connection handle and
does not imply persistence across host restart.

Request/operation IDs track command submission, acknowledgements and transfers;
they do not identify the print shown by status or supply special-action context.
Deduplication for a repeated request must preserve its recorded result within
the authority's retention lifetime even if its action reference has since been
consumed or invalidated. A new request must validate context again; references
are not universally single-use unless the action's semantics require that.

Distinguish submission rejection, recorded acceptance and an unknown submission
outcome. An accepted command is not necessarily acknowledged by the device;
acknowledgment is not physical completion. Completion needs a device result or
an appropriate observed-state confirmation. Transport loss after dispatch can
leave the outcome unknown and must not be relabeled as safe failure.

The command-only terminal phase `accepted` means that the device acknowledged the
command and the provider cannot observe physical completion. It is distinct from
submission's `recorded` result and from the nonterminal `acknowledged` phase used
while awaiting completion evidence. Consumers end their pending interaction on
`accepted`, without presenting it as `completed` or retrying the command.

Preserve a way to reconcile submitted work after a view or subscription closes.
Service-scoped operation tracking is the proposed solution; its concrete
ownership and persistence are open. Request identity can support lookup and
deduplication within the authority's defined lifetime, not a claim of device-level exactly-once
execution. Do not automatically repeat a potentially completed print or motion
command because a response was lost. Unknown or expired lookup results do not
prove that the original command was never executed.

Cancelling an observation or local wait does not undo a submitted command.
Upload cancellation is a separate transfer operation and may leave remote
bytes. There is no universal cancellation operation for arbitrary physical
actions; job cancellation remains an explicit printer command.

## 8. Cameras and media resources

Describe cameras as hardware resources, optionally associated with a tool or
light. Expose their availability and observed state separately from supported
live-view formats, snapshots, enable/disable controls and timelapse modes.
Do not infer camera controls from the mere presence of a stream.

The current proposal shares a managed media-resource boundary between live
camera viewing and stored-file presentation. This reuse is not required if
separate abstractions better preserve consistent availability, authorization,
playback and cleanup semantics. Select delivery against client transport and
format/codec support.
The domain can describe browser-consumable HTTP video, HLS, MJPEG or WebRTC
without requiring every provider to implement all of them. Protocol-specific
camera addresses and private transport credentials remain agent concerns;
a source URL is not evidence of browser playback capability.

A media resource manages temporary delivery information,
expiry/renewal where applicable, state, errors and explicit closure. Advertise
available profiles, resolution/frame rate and playback properties such as
duration and seekability when known; these are not guaranteed for every stream.
If WebRTC is selected, its signaling must handle offer/answer and ICE without
losing initial signals. Negotiation identities and descriptor revisions are
candidate mechanisms. Opening returns a serializable descriptor/reference, not
a client object with bound methods. Watch, renew, signaling, content reading and
closure each supply the explicit resource reference and work independently of
control/observation calls. A source failure requires an explicit resource error
or revalidation; it does not invalidate unrelated controls. Request IDs permit
open retries without allocating duplicate viewers within the authority's defined
retention lifetime. Signaling gaps must be reported rather than silently losing
initial messages. Respect applicable concurrent-view limits and
release resources when viewing ends.

Snapshot capture is independent of live viewing. Device-level timelapse
configuration is separate from a print job's timelapse options. A recorded
timelapse is a remote file, not a live camera resource. Neither camera capture
state nor recording metadata requires or exposes a native job ID to correlate
with application-submitted work. Watching a camera must not implicitly enable
recording.

### 8.1 Bambu LAN live view and shared playback

**Decision status:** Accepted design; isolated H.264 timing, fMP4 and MSE
feasibility is demonstrated with generated fixtures on macOS ARM64 in Chrome
and Electron. Production implementation is authorized in independently verified
and committed increments. Shared media contracts, the delivery player and native reader/remux are
delivered, including document-owned resource/transport integration and the shared Camera card. H2D H.264 LAN playback is accepted on the macOS ARM64 development host; JPEG hardware and six-platform packaged playback remain qualification gates. The [console specification](Printer%20Console%20and%20Control%20Integration.md#camera-live-view)
owns presentation and viewing intent.

Keep the existing `open-bamboo-networking` **v2.2.0** artifact pins and all six
desktop targets. Use its companion `BambuSource` through the public
[Orca tunnel declarations](../packages/slicer-wasm/cpp/src/slic3r/GUI/Printer/BambuTunnel.h).
Do not build or patch the plugin. This increment excludes TUTK/Agora, native
WebRTC delivery, remote-file browsing, recording/timelapse settings, snapshots,
a browser-native Bambu provider and a new gateway. Shared remote-URL playback
is an agent-neutral player capability, not Bambu WAN connectivity.

#### Delivery and ownership

| Source | Agent/host delivery | Shared presentation |
| --- | --- | --- |
| Bambu H.264 | Fragmented MP4 initialization and media segments | MSE feeding an HTML `video` element |
| Bambu MJPEG | Complete JPEG frames, without transcoding | Blob-backed HTML `img` |
| Remote browser-playable video | URL, MIME and explicit credentials mode | HTML `video` URL playback |
| Remote HLS | Playlist URL and explicit credentials mode | Native HLS when supported, otherwise hls.js feeding `video` |
| Remote HTTP MJPEG | Multipart MJPEG URL | HTML `img` URL playback |

Protocol-specific addresses, access codes, certificate setup and plugin handles
remain private to the existing Bambu utility. LAN-only devices use authorized
host records and the reported liveview protocol. Cloud-associated devices may
use v2.2.0's camera URL accessor for a **LAN** connection; no returned URL means
LAN access is unavailable, not permission to switch to a WAN implementation.
Use reported `ipcam.liveview.local` rather than an unconditional model-to-port
table. Unknown camera fields remain unknown; camera hardware, adapter support,
device-disabled liveview and temporary reachability are distinct conditions.

The native reader uses a dedicated thread, copies borrowed samples before the
next plugin read, and supports orderly cancellation/close before destroying
the tunnel or unloading the library. It must not occupy the account/control
call queue. Encoded-video remuxing belongs to the host; no slicer-WASM or
wxWidgets dependency is introduced. Main establishes a document-owned binary
channel between utility and renderer; frame traffic does not traverse ordinary
state RPC or React state. No local HTTP server is required. Bound every queue
in the reader, muxer, channel and player, including bytes as well as item count.
The first production increment permits one Bambu view per application instance;
this is an adapter limit, not a discovered printer hardware limit.

#### Media resource contract changes

The single current [media contract](../packages/platform-contract/src/printer/media.ts)
now includes explicit `mse-fmp4` and `jpeg-frames` delivery variants. Each carries an
opaque stream identity and its format; MSE carries the complete MIME/codec
string. Keep URL delivery separate from binary delivery. The `readStream`
operation takes the media reference, stream identity and cancellation signal,
returning binary messages as a local asynchronous stream. This is an SDK
interface, not a JSON DTO or a prescribed gateway wire protocol. Neither
descriptors nor shared UI expose Electron MessagePorts or native objects.
Update capability negotiation, dispatch, bindings, mocks and compile fixtures
together; do not add parallel old/new contracts.

`open` is request-ID-idempotent within its declared retention lifetime. `watch`
publishes descriptors, state and errors, not video bytes. Binary messages carry
generation and sequence plus initialization/media-segment or JPEG-frame kind.
Only one binary consumer attaches to a local media resource in this increment.
Retain initialization state until attachment without retaining unbounded video;
start H.264 delivery at a decodable keyframe. A changed codec/configuration or
reconnection starts a new generation and invalidates old data. Report a gap
rather than silently concatenating missing segments. `readContent` remains for
content/range reads and is not repurposed as a live-stream poll.

Resources bind the printer, route and configuration revision. Opening does not
require a caller-owned observation subscription or an active print job; the
host coordinates any needed device read without stealing another selection.
Closing is idempotent. Reader cancellation, document navigation/closure and
unattached-open expiry release native and JS resources. Account invalidation
closes account-dependent views while preserving independently authorized LAN
resources. Video failure does not invalidate controls or log out the account.
Retain the existing exclusion of provider-process restart/recovery.

The implemented [media owner](../apps/desktop/src/utility/bambu/media.ts) retains
request IDs for five minutes (advertised in live-view constraints), renews
five-minute resource leases, and closes unattached resources after ten seconds.
It owns a private monitor lease while resolving reported protocol and LAN
credentials. [Main-process ownership](../apps/desktop/src/main/bambuMediaIpc.ts)
binds resource references to the initiating main-frame document. Navigation,
renderer loss and window destruction retire that owner, including late opens.
The dedicated channel admits one outstanding pull and bounds queued data to
64 packets / 8 MiB; JPEG replaces pending stale frames. Overflow terminates the
stream with a gap error rather than dropping AVC dependencies.

Native callback/ownership tests, resource/channel tests, workspace typechecks
and the [Electron port test](../apps/desktop/e2e/bambu-camera.e2e.ts) pass on the
development host. The latter uses the production resource owner, utility/main/
preload boundary and real MessagePorts with a synthetic JPEG reader; navigation
proves reader closure. It does not qualify printer authentication or real-device
control responsiveness during video. The production decoder/remux path is
verified separately by the pinned-plugin fixture below.

#### H.264 timing, fragmentation and recovery

Read SPS/PPS and IDR flags, convert Annex-B access units to length-prefixed AVC,
and remux without encoding. A muxer emits fMP4 initialization followed by media
segments. Begin on an IDR; a decoder-configuration change requires a new
generation. Prefer a maintained muxer behind a narrow host boundary; its actual
fragment emission behavior must pass the probe before selecting it for product
use. A fragment-duration option alone is not evidence of low latency.

The pinned plugin exposes `decode_time` in 100ns units, derived from host
arrival time rather than independent original PTS/DTS. For a verified stream
without frame reordering, normalize to a monotonic timeline relative to the
first accepted IDR, retaining measured frame spacing. Do not assume arbitrary
streams have PTS equal to DTS. Frame reordering, timestamp regressions and long
gaps must be detected/rejected or explicitly handled before their input class
is advertised. Arrival-time fixture tests do not qualify real-printer timing.

The plugin's ready queue can discard old access units without exposing a loss
sequence. Keep reading promptly; do not propagate a stalled UI into an
indefinitely blocked native read. Own-channel overflow/gaps terminate the invalid stream; explicit Retry opens a
new resource and waits for an IDR. Timestamp discontinuities within the muxer
reset its generation and wait for an IDR; plugin-internal loss is a separate limitation
requiring decoder-error/stall recovery and hardware qualification. Never drop
arbitrary interdependent H.264 packets and call the remaining stream complete.

The MSE consumer checks the actual MIME/profile, serializes append/remove,
limits pending bytes and buffered duration, evicts old media and follows the
live edge. A 15-second frame watchdog detects continued delivery without
displayed frames; explicit Retry is required after decoder/transport failure.
Autoplay denial presents Play without reconnecting. Lease renewal updates the
expiry timer without reattaching the binary consumer. Failed append, codec change or generation change rebuilds playback
from initialization plus an IDR. JPEG delivery instead replaces stale pending
frames, displays only a successfully decoded image and revokes displaced Blob
URLs. Neither path buffers an entire live session.

#### Remote URL compatibility

Agents declare delivery type rather than relying on URL suffixes. Include MIME,
live/seekable properties, expiry and credentials mode; use renewable signed
URLs or an explicitly supported cookie mode. Do not assume `video.src` can set
arbitrary Authorization headers. HLS playlists, segments and keys must all be
browser-accessible. Preserve HTTPS, CSP and Web COOP/COEP; configure the media
origins and CORS/CORP instead of disabling isolation. Direct playback must not
download a whole file first. URL support does not create an agent-management
UI or a gateway. Mobile product acceptance remains deferred; viewing controls
must remain touch-usable and hidden views must release buffers and connections.

#### Implementation and acceptance sequence

| Increment | Deliverable | Acceptance boundary |
| --- | --- | --- |
| 1 — feasibility (delivered within fixture scope) | Isolated probe for pinned-plugin H.264 samples, timestamp normalization, fMP4 emission and real MSE playback | Record source provenance, timestamp/fragment timings and actual decoded frames; short/long GOP and arrival-jitter playback, plus unit rejection of discontinuous timelines. Separate fixtures from physical-printer evidence. Keep the probe out of production entrypoints. |
| 2 — shared contract/player (delivered) | Binary media contract, URL/HLS/JPEG/MSE adapters | Compile fixtures and dispatch coverage; cancel/switch/expiry/cleanup; real HTTP URL/HLS and MSE playback in affected hosts. |
| 3a — native reader/remux (delivered) | Public BambuSource loader, independent reader and continuous AVC fragments | Real library open/read/close, buffer ownership, bounded queues, failure/cancellation and short/long GOP MSE playback. |
| 3b — native media owner/transport (delivered) | Resource lifetime, credentials and document-owned binary delivery | Request idempotency, route/account lifecycle, cancellation, channel bounds and control responsiveness during viewing. |
| 4 — camera integration (delivered within fixture scope) | Capability/observation mapping and shared Camera card | LAN-only and cloud-associated LAN cases, absent/disabled/unknown camera states, first frame, user stop and hidden-page cleanup. |
| 5 — qualification (H2D LAN development-host subset accepted) | Six-platform packaged playback plus hardware acceptance | At least one JPEG and one H.264 printer; sustained playback, reconnect, bad credentials, stop latency and concurrent control responsiveness. |

Each production increment remains separately reviewable and verified under the
[testing guidelines](../doc/testing_guidelines.md). Complete and commit each increment after its independent acceptance before
starting the next. Fixture success does not replace hardware or release qualification.
Measured first-frame/fragment delays are evidence, not automatic product SLAs.
No WASM rebuild is needed unless the implementation actually changes that
boundary. A working generated stream, fixture server or plugin load must not
be reported as real-printer, TLS/authentication or six-platform acceptance.

#### Feasibility result and remaining gate

The opt-in [probe](../apps/desktop/scripts/camera-prototype/run.mjs) loads the
checksum-verified v2.2.0 companion library through the checked-in Orca ABI.
It generates baseline AVC locally, sends it through an isolated loopback
RTSPS server with a fixture CA, and remuxes the returned samples with the
development-only `mediabunny@1.62.1`. Fixture pacing and native sample drainage
run in a separate Worker from the browser driver. The production account,
control and media implementations are not involved. Reproduction commands and
artifact locations are in the [README](../README.md).

On the macOS ARM64 development host, Chrome 156 and Electron 43 passed all
three generated-source cases: 30 fps with a 15-frame GOP, a 90-frame GOP, and
a 15-frame GOP with arrival jitter. Every source sample reached the reader;
100ns timestamps normalized to the expected stream span. MSE accepted the
initialization/media fragments and presented sustained video with monotonic
decoded frame identifiers through the tail of each source. This proves the
fixture's no-reordering path, not arbitrary AVC profile/reordering support.
Unit cases reject duplicate/regressing timestamps, gaps over the probe's
one-second admission threshold, missing initial IDR and unsupported codec
configuration. They do not establish reconnect or decoder-error recovery.

The muxer emits fragments at keyframe boundaries: `minimumFragmentDuration`
is a minimum, not a latency bound. With a 200ms setting and one-sample duration
lookahead, measured first-fragment delay was about 0.53–0.54 seconds for the
15-frame GOP and 3.04 seconds for the 90-frame GOP. First presented frame with the comparison muxer was
about 0.56–0.86 seconds and 3.06–3.10 seconds respectively across the two hosts.
These are short fixture runs, include browser-driver transport overhead, and
do not establish an SLA or production live-edge behavior. The probe's finite
buffers and end-of-stream drain do not qualify a sustained live player.

**Muxer selection:** The Mediabunny feasibility candidate remains confined to
the comparison probe. Production uses pinned `mp4box@2.4.1` through the narrow
[host muxer](../apps/desktop/src/utility/bambu/cameraMuxer.ts). It emits continuous
fragments on a roughly 200ms sample window with one-sample duration lookahead;
fragments between keyframes depend on the earlier IDR in the same generation.
Startup still waits for an IDR. A fresh bounded builder per chunk prevents
MP4Box sample/box metadata from growing over a live session. No transcoding or
plugin change is introduced. Slice admission rejects B slices and unsupported
partition/extension slices rather than assuming their PTS equals arrival DTS.
The H2D timestamp/profile and saved-credential RTSPS path have the scoped
acceptance below. Other hardware/profile behavior, hidden plugin-queue loss,
forced network-loss recovery, bad-credential handling and packaged six-target
playback remain unqualified. JPEG and remote URL/HLS delivery are exercised separately by the shared-player
check described below; they are not exercised by this H.264 probe.

The native reader uses its own thread and the common Orca tunnel header. It
copies borrowed samples before the next plugin call, caps each sample at 4 MiB
and the ready queue at 64 samples / 8 MiB, and reports overflow explicitly.
Cancellation joins the reader asynchronously before closing/destroying the
tunnel and unloading the companion library. An in-progress plugin open must
return before its thread can exit; its timeout remains part of real-device
stop-latency qualification. The reader and remux tests cover owned bytes,
100ns timestamps, bounded queues, connection errors, cancellation, clock-reset
IDR resynchronization and unsupported B slices. Neither reader nor remux runs
on the serialized networking-agent call queue. The production-reader/remux
comparison passes all six short-GOP, long-GOP and arrival-jitter cases in Chrome
and Electron on macOS ARM64. The 3-second GOP emits its first fragment after
about 202–232ms and first displayed frame after 242–256ms in these fixtures;
this is not a printer/network latency guarantee.

The shared [delivery player](../packages/slicer-app/src/components/device/media/playback.ts)
consumes descriptors and `readStream` without printer-state subscriptions.
URL descriptors carry MIME and `same-origin` or `include` credentials modes,
matching HTML CORS semantics; arbitrary authorization headers are not supported.
The owning view retains open/renew/close responsibility. The player cancels its
reader, removes media sources and revokes object URLs on stop, switch, expiry
or failure. MSE appends are serialized, packet bytes and retained duration are
bounded, old live buffers are evicted, and excessive lag seeks toward the live
edge. New generations recreate MSE from initialization; a missing packet fails
rather than concatenating a damaged stream. JPEG decoding retains only the
latest pending complete frame. Autoplay denial exposes a Play action.

The opt-in shared-player check uses the actual shared module in Chrome and
Electron with cross-origin HTTP media fixtures under COOP/COEP. It covers MSE,
direct MP4 URL, hls.js fallback, JPEG bursts, HTTP MJPEG, generation switching,
abort/source cleanup, expired access, oversized packets and sequence/initialization
gaps. Native-HLS execution remains a host qualification item. Future
agent origins require explicit host/deployment CSP permission plus media-server
CORS/CORP; the player does not weaken application isolation or grant origins.


#### H2D LAN development-host acceptance

On 2026-10-24, the production desktop build used the previously authorized,
independent LAN profile with the account signed out. The actual H2D reported
RTSPS/H.264; v2.2.0 connected on TCP 322 while MQTT status remained on TCP 8883.
No mock printer handler, transcoding, TUTK or recording-setting change was used.
The real reader, host muxer, utility/main/preload binary channel and shared
Monitor player all participated. The decoded stream was 1680×1080,
`avc1.64c029`.

| Measurement | Observed result, not an SLA |
| --- | --- |
| Reopen to initialization / first media fragment / first presented frame | 1.279 s / 1.480 s / 1.508 s, measured from Play |
| First 100 media-fragment intervals | Mean 222.9 ms; range 198.7–268.6 ms |
| Continuous live timeline | Over 406 s, crossing a five-minute resource lease without replacing playback; no observed media-time regression or playback error |
| Retained MSE range / live-edge distance at checkpoints | About 4.4–5.2 s / 0.16–0.32 s; this distance is not camera-to-screen latency |
| Browser frame accounting at the final long-run checkpoint | `totalVideoFrames=12215`, `droppedVideoFrames=465`; this run is not zero-drop qualification and includes live-edge following and display transitions |
| Concurrent on-demand status read | Fresh response in about 0.95–1.20 s during video |
| Explicit Stop / leaving Device for Home | Video TCP connection absent after about 94 ms / 137 ms; MQTT remained available |
| Closing the normal window during video | Video and MQTT connections absent after about 329 ms |

A normal Electron launch, without Playwright startup flags, also passed
application-window HTML fullscreen entry/exit, hidden-document release and
restored playback after minimize. The Playwright page connection was detached
for visibility acceptance: its focus emulation otherwise forces the document
visible while the native window is minimized. Returning from Home resumes
prior viewing intent; explicit Stop remains stopped after leaving and returning.
The final macOS window policy and enlarged player pass both real-H2D and
Electron fixture acceptance. Local metrics/screenshot evidence is ignored under
`.vitest/camera-acceptance/`; it contains no access codes or camera source URLs.

Available software checks pass: workspace `pnpm test` (with the existing
opt-in WASM/runtime skips), `pnpm typecheck`, production desktop build/CSS smoke,
real v2.2.0 native smoke, shared-player Chrome/Electron cases, and the targeted
camera/control Electron journeys. No native WASM rebuild was required.
Only one H2D was available. Physical MJPEG, cloud-associated camera URL
resolution on hardware, wrong credentials, forced network loss/reconnect,
longer unattended runs and six-platform packaged camera playback remain open.
The six v2.2.0 artifact pins, including macOS x64, are unchanged. Earlier
six-platform plugin-startup qualification does not qualify this new video path.

### 8.2 Snapmaker U1 LAN live view

**Decision status** — WebSocket camera control, HTTP JPEG acquisition and shared
`jpeg-frames` playback are accepted with the host, lifecycle and acceptance
decisions below. Both hosts have software acceptance and the Windows
development-host U1 qualification recorded below. Web physical acceptance
covers the tested HTTP loopback origin. Production HTTPS deployment needs
its own origin and browser-permission qualification.
The provider-private [camera RPC client](../packages/printer-control/src/snapmaker/camera-protocol.ts)
and host-created socket contract are implemented with protocol-fixture coverage.
The [managed camera owner](../packages/printer-control/src/snapmaker/camera.ts)
and Web/shared Camera integration are implemented within fixture acceptance.
Host transports perform HTTP acquisition. Shared playback handles bounded
JPEG recovery and activity renewal. The independent
[Electron camera utility](../apps/desktop/src/utility/snapmaker-camera-host.ts)
owns WebSocket control, HTTP reads and managed resources. Its
process starts on the first camera-open operation. Saving configuration alone
does not create it. The
[main-process binding](../apps/desktop/src/main/snapmakerCameraIpc.ts) verifies
the renderer's configuration digest against persisted configuration before
granting access. Main supplies document ownership, invalidates saved connection
changes and retires viewers on navigation, renderer loss and window destruction.
Binary frames reuse the pull-based camera channel, with one consumer and
latest-frame replacement for queued JPEGs. Shutdown allows seven seconds for cleanup
before terminating an unresponsive camera utility.
Electron and browser E2E fixtures cover real JPEG decoding, recovery, interaction
renewal and hidden/document release. Electron additionally verifies the actual
utility process and isolated preload/binary path. Sustained hardware results
and their deployment limits are recorded in this section.
The [Snapmaker camera interaction](Printer%20Console%20and%20Control%20Integration.md#snapmaker-camera-live-view)
owns presentation and viewing intent. The delivered Snapmaker submission and
current-task thumbnail boundaries in section 2.5 remain independent.

#### Initial delivery and image coverage

Electron and Web are both initial delivery targets. They share the Snapmaker
protocol/resource logic and JPEG presentation, with separate acceptance for
each host's networking, authorization and document-lifetime boundary. Web
availability remains subject to deployed-origin restrictions, mixed content,
CORS and local-network permission. Report those restrictions through the
camera's availability/error path and retain unrelated printer operations.

Initial qualification targets stock U1 firmware exposing the selected
Moonraker WebSocket control and HTTP JPEG path. Resolve support per function;
a firmware version string alone neither enables nor disables the feature.
Community firmware can use this path where compatible. Its additional
WebRTC/MJPEG services require a separate follow-up adapter and qualification.

Initial image support covers ordinary JPEG acquisition over the selected LAN
route. An encrypted image source produces an explicit playback-unavailable
result. Password-derivation fields in a start response do not trigger decryption
of a plain JPEG. Unsupported encryption and a malformed ordinary frame need
distinct diagnostics. Encrypted delivery requires its own samples and
qualification before it can be advertised as supported.

#### Connection configuration and capability discovery

Camera access reuses the saved Snapmaker API base URL and optional API key.
Host adapters establish and authorize the WebSocket connection from that
configuration. The camera adds no independent endpoint or credential fields.
Resolve the device's WebSocket and image endpoints consistently with the
configured scheme, port and proxy prefix. Keep any authentication exchange
and temporary credentials inside the host/provider boundary. A change to the
saved connection invalidates its camera resources and derived access state.

Interpret the relative camera URL in the device's `/server` file-service
namespace and retain any configured reverse-proxy prefix. Validate absolute
source URLs against the configured device origin before attaching credentials.
Use URL-aware resolution for scheme, port, query and IPv6 handling; acquisition
must retain its authorized route when a descriptor or configuration changes.

For API-key authorization, the host may obtain a single-use WebSocket token
through the configured device's authenticated
[Moonraker token endpoint](https://github.com/Snapmaker/u1-moonraker/blob/ed7b3752a9a938c87ee086f3b7b21a9352a2a0c9/moonraker/components/authorization.py#L263).
The browser WebSocket API requires an authorization mechanism compatible with
its handshake. Obtain a fresh token for a new connection and keep temporary
tokens out of persisted configuration, shared descriptors and logs. HTTP
image requests retain the configured API-key authorization. Fixture tests
must cover authorized and rejected handshakes; hardware evidence remains
limited to the authorization mode actually exercised.

When a connected Snapmaker route has no reliable device camera-capability
report, Monitor still exposes a camera card with an explicit Play action.
Play performs on-demand camera validation. Rendering the card does not start
the device monitor or imply that the firmware has confirmed camera support.
Represent adapter delivery support separately from unknown device state.
An explicit unsupported-method response produces a visible unsupported reason;
authentication, permission, transport and temporary acquisition failures keep
their own meanings. Do not treat a timeout as proof of absent hardware.
Capability findings are scoped to the connection/configuration context rather
than persisted as a permanent property of a printer model.

#### Protocol evidence and qualification boundary

The official Snapmaker Orca
[committed device-page bundle](https://github.com/Snapmaker/OrcaSlicer/blob/bac6fd5c1e1c23ddf057cf6471ba4ed7ed621c4c/resources/web/flutter_web/main.b347974c91352c2f.js)
encodes `camera.start_monitor` and `camera.stop_monitor`. Its camera control
uses WCP/MQTT; the selected Neo route uses the Moonraker WebSocket endpoint.
The shared RPC method names do not establish identical transport or
authorization requirements.

A LAN probe on 2026-11-08 used one U1 reporting firmware
`2.0.0.205_20260914173503` and Moonraker `2.0.0`, with its existing Neo
configuration and no API key. HTTP JSON-RPC accepted a device information
request but rejected both camera methods with `-32601`, indicating an
unsupported HTTP transport. The same camera methods succeeded through
`/websocket`. Start used LAN domain, interval zero, password-parameter request
and a probe-owned client ID. Its response supplied a relative image URL and
password-derivation fields. HTTP acquisition through
`/server/files/camera/monitor.jpg` returned ordinary, decodable JPEG images.
The presence of password fields alone does not identify an encrypted payload.

Continuous acquisition crossed five minutes and an explicit repeated start
succeeded as renewal. The firmware lease duration remains unmeasured.
Request completion and distinct image
content were checked separately. A response-body interruption and a truncated
JPEG establish the need to handle individual failed frames. The measured
image dimensions and update rate remain specific to this probe.

Stop returned success, but the image continued updating after the probe
connection closed. Another connection existed before the probe, with unknown
ownership. Client-ID isolation, immediate device capture shutdown and the
unrenewed expiry duration remain unqualified. Browser image access was checked
from one localhost development origin only. Authenticated access, encrypted
images, production HTTPS Web access, forced reconnect and other firmware
versions require separate qualification. Integrated Neo feature acceptance
remains pending.

Third-party implementations provide corroborating design references.
[PrintsNCode](https://github.com/PrintsNCode/Anycubic-Snapmaker-remote-cam-lan/blob/712621696a1c60626097f1d9adbdc911cccccb38/Remote-cam-Multi-V2.html)
uses WebSocket wake-up and JPEG polling. The
[Stock Camera Fluidd bridge](https://github.com/Dr-Hack-N-Sniff/Snapmaker-U1-Stock-Camera-Fluidd/blob/de618429684169c6f4f68d7e5de8051f964bea4e/u1_mjpeg_bridge.py)
uses printer-local MQTT and JPEG-to-MJPEG delivery. Hardware-encoded
[WebRTC delivery](https://github.com/Bespok3d/u1-hw-camera/blob/d35d95f7ad0c0e33b30f4c8ca7e6cbfc86bf117d/plugin/files/etc/init.d/s65camera-hw)
adds printer-side services. These projects inform protocol and lifecycle
analysis; their performance and compatibility claims are not Neo qualification.

#### Selected data path and ownership

The Snapmaker agent owns camera RPC encoding, response validation, acquisition
URL resolution, renewal and conversion into complete JPEG packets. Host
adapters own HTTP and WebSocket networking. Shared application code consumes
the existing [managed media contract](../packages/platform-contract/src/printer/media.ts)
and [JPEG player](../packages/slicer-app/src/components/device/media/playback.ts).
The existing [HTTP transport](../packages/platform-contract/src/printer/transport.ts)
is complemented by a host-injected WebSocket seam with cancellable
connection, message, error and close handling. Correlate JSON-RPC responses by
request ID and validate their result/error payloads. Notifications and
unrelated responses must not complete a pending camera request. Pending
requests retain their cancellation/deadline scopes and retire when their
connection ends.

Electron executes the camera protocol, resource owner and acquisition loop in
a utility-process host, independently of slicing and printer-operation queues.
Main coordinates configuration access and main-frame document ownership. It
retires that document's resources on navigation, renderer loss or window
destruction, including late opens. Frame delivery reuses the existing
document-owned binary-channel pattern from section 8.1. The renderer adapter
exposes the domain media interface and keeps Electron objects behind its host
boundary. The HTTP-agent assembly uses a narrow media implementation
injection point; this does not relocate unrelated Snapmaker operations.

Web executes the same protocol/resource logic through its browser host
adapters and document-owned lifetime. Browser asynchronous HTTP/WebSocket
networking and the shared browser image decoder provide this JPEG path.
Capability negotiation and cleanup use the same domain contract in both
hosts. The camera path is independent of the Emscripten module and its
slicing Worker.

The intended sequence is media open, acknowledged camera start, frame
acquisition, complete JPEG packet delivery and shared image decode/display.
Connection acknowledgement and the first valid displayed frame are separate
states. Camera networking and delivery remain independent of slicing and
printer-control operation queues. Frame bytes use `readStream`; media `watch`
carries descriptors, states and errors. Source URLs, authentication material
and password-derivation data remain provider-private.

Video presentation advertises its optional `playbackRecovery.timeoutMs` policy.
Shared playback uses that budget and provider connection state to coordinate
recovery across transport acquisition and client decoding. Delivery describes
transport, encoding and access. Each media resource declares
`acceptsUserActivity`, independently of its presentation or transport. Shared
UI forwards direct user activity through `media.interact` for accepting resources
and coalesces overlapping notifications. The provider owns any resulting
session maintenance and its rate limits. Media-resource lease renewal remains
a separate operation.

Reuse the resource identities and configuration guards in section 8. Opening
and closing retain their request-idempotency and late-result cleanup
requirements. A configuration change cannot redirect an old resource to a new
endpoint. The concurrency and release policy below defines how local and
device resources are retired.

Acquisition requires latest-frame buffering, cancellable requests, serial frame
fetches and cache avoidance. URL resolution must preserve configured scheme,
port, proxy prefix and IPv6 handling. Delivery accepts complete JPEG frames;
failed or undecodable individual frames retain the previous valid image while
the recovery policy below runs. Neither HTTP success nor a new URL query
proves a fresh frame.

Renewal of the device monitor and the Neo media-resource lease are separate
responsibilities. Renewal may change private source or decryption information.
Any change that invalidates delivery must respect media generations and reject
late packets from the previous generation. Keep the current stream and image
through a renewal that preserves delivery configuration.

Neo adopts the manufacturer's LAN renewal policy. An acknowledged start or
renewal arms a 300-second timer. Expiry repeats `camera.start_monitor` with the
same session client ID, then rearms the timer after success. Direct pointer,
touch or keyboard interaction with the active camera card can also renew,
with interaction-triggered attempts throttled to at most once per minute.
Coalesce overlapping timer/interaction requests into one in-flight operation.
Qualifying activity belongs to the visible camera's user interaction path.
Hiding, Stop and resource retirement cancel all renewal triggers.

This policy follows the committed Orca
[timer and restart implementation](https://github.com/Snapmaker/OrcaSlicer/blob/bac6fd5c1e1c23ddf057cf6471ba4ed7ed621c4c/resources/web/flutter_web/main.b347974c91352c2f.js#L153072).
The chosen interval is a client policy. Firmware TTL remains unqualified.
A failed required renewal enters bounded recovery. Keep device renewal
independent of resource-lease refreshes, and preserve session/client identity
when re-establishing its transport.

#### Acquisition cadence and bounded recovery

Initial acquisition permits at most five image requests per second, with one
request in flight per viewing session. Enforce spacing between request starts
and avoid catch-up bursts after slow requests or suspended execution. This is
Neo's request budget; advertised source FPS remains unknown unless reported
or independently established. The image source may update less frequently
than requests complete.

Recoverable transport interruptions and consecutive invalid frames permit an
automatic recovery window of at most 30 seconds while viewing remains
requested and visible. Keep the last valid displayed image and expose recovery
status. Discard individual malformed frames and retry with bounded pacing.
Successful control acknowledgements alone do not end recovery or reset its
budget. Recovery requires valid displayed playback and restoration of any
failed required control/renewal path. Continued image reads cannot mask a
failed control connection indefinitely. A new failure after recovered
playback starts a new recovery window.

If the window expires without recovery, release the view and expose an error
with explicit Retry. Authentication failure, denied permission, confirmed lack
of camera support and unsupported encryption require user action directly.
Stop, context change and hidden-view release cancel retries immediately.
Retry after a terminal failure opens a new resource rather than extending an
expired recovery budget.

The acquisition and shared JPEG player paths must distinguish an isolated bad
frame from a terminal delivery failure without bypassing media generations or
resource ownership. A retained image must not imply healthy live playback
during interruption. The shared viewing owner coordinates the user-visible
recovery window across provider state and local decoder feedback. Recoverable
acquisition uses a nonterminal connecting state while retaining the media
resource. The shared player reports isolated decode failures and successful
presentation to that owner without turning each bad JPEG into a terminal
error. A pending-stream watchdog must respect this bounded recovery window.
Terminal source errors retire the resource through the normal error path.

The UI exposes connection and recovery status. Last-received timestamps and
source-freshness indicators are outside the selected presentation. Identical
image content alone does not establish a stall in a static scene. Tests and
hardware acceptance still distinguish receipt, decoding and source updates.
Per-attempt timeouts and bounded backoff must fit inside the remaining
recovery budget. Their implementation values may be tuned through fixtures
without extending the accepted 30-second user-visible window.

HTTP acquisition buffers the current response under its cancellation/deadline
scope. Encoded delivery and pending decoding retain the latest queued frame,
replacing obsolete JPEGs independently of session length. The shared media
consumer applies its established packet-admission contract.
Within a generation, delivered sequence numbers remain contiguous. Reopening
an interrupted source starts a new generation with a complete JPEG.

#### Viewing concurrency and release

Each Neo application instance permits at most one active Snapmaker camera
view. This cap is an adapter resource policy. U1 hardware viewer limits remain
unqualified.
Selecting another device releases the old view before opening a replacement.
Concurrent open/retry calls must respect that limit and request-ID idempotency.
The host-wide admission owner returns busy to a competing document rather
than silently taking over its active view. Same-document device switching
releases its previous resource before requesting the next one.
Separate Neo instances and other vendor applications are external viewers;
their limits and interaction remain separate qualification cases.

Release follows the manufacturer's explicit monitor-release convention.
Cancel local acquisition and renewal, then make a bounded best-effort
`camera.stop_monitor` call using the viewing session's LAN domain and the same
client ID used by its start/renew calls. A session owns its client identity;
do not borrow a different application's identity or omit a previously used
client ID to retry a failed stop. Finish local connection, timer and buffer
cleanup even if the stop request fails or times out. A cleanup attempt must
retain its original configuration context rather than resolve a newly edited
endpoint. A late successful start after cancellation also requires cleanup
against its original context.

Explicit Stop clears viewing intent. Leaving Monitor, hiding/closing the
document, changing route/configuration and reaching a terminal playback error
all release the view and cancel recovery. Temporary hiding may retain the
shared viewing intent for the same selected device and reopen on return, as
specified by the shared Camera interaction. Serialize local release/reopen
through the bounded cleanup attempt and ignore completions for a retired
session. Device-side ordering after a transport timeout remains part of the
unqualified monitor-isolation behavior.

Stop acknowledgement is not proof of client-ID isolation or immediate device
capture shutdown. Preserve those qualification limits and test coexistence
with external viewers without promising device-wide camera power control.

#### Verification requirements

Protocol and resource fixtures must exercise RPC result correlation, device
errors, cancellation, late starts, renewal changes, configuration invalidation
and idempotent release. Acquisition/player coverage must distinguish a
completed response, a decodable image, a newly received frame and actual
source freshness. Cover corrupted images, response interruptions, bounded
buffering and resource release while preserving unrelated printer controls.

Implementation completion requires both the applicable software checks and
real-U1 acceptance in Electron and Web, with at least 30 minutes of continuous
viewing in each host. Cover renewal across repeated intervals, the first
displayed frame, a short network interruption and recovery, explicit Stop,
Retry, document visibility/closure, device switching and coexistence with
another client. Observe the other client's viewing before and after Neo's
release and report any interference. A failed coexistence case is a design
issue to resolve before claiming completion. Keep device-side shutdown and
client-isolation claims limited to what the acceptance actually establishes.

Web qualification records the actual application origin, transport security
and local-network authorization conditions for the successful viewing path.
Also verify the unavailable/error presentation under denied or incompatible
browser conditions. Successful localhost playback alone does not qualify a
production HTTPS deployment. The selected scope uses direct device access;
the shared architecture's gateway deferral still applies.

Record firmware and authorization mode for each hardware run. Fixture-only
authorization or encrypted-source rejection coverage is not physical
qualification of authenticated or encrypted acquisition. Apply the
[testing guidelines](../doc/testing_guidelines.md) to software verification;
the real-U1 gates above are additional feature completion requirements.

Mobile qualification remains deferred under the shared application's initial
desktop-browser policy. The shared card retains its existing narrow-width
layout and touch-compatible buttons. One active view and bounded JPEG storage
constrain media memory independently of session duration. Mobile fullscreen,
network permissions, sustained decoding and background behavior need separate
qualification before mobile support is claimed.

#### Windows development-host camera qualification

Acceptance on 2026-11-08 used stock U1 firmware
`2.0.0.205_20260914173503`, plain 1920×1080 JPEG and the saved LAN API
configuration with an empty API key. Electron 43.4.0 ran the development E2E
application with mock slicing. Chrome 156.0.8078.81 ran the built Web application
with real threaded WASM. Camera execution is independent of the slicing module.

| Host | Sustained viewing | Repeated timer renewal | Display evidence |
| --- | --- | --- | --- |
| Electron on Windows x64 | 1,835.109 seconds | Five observed intervals of 300.066–300.170 seconds | 8,678 displayed-image changes by the last periodic sample, with 122 distinct sampled JPEG hashes. |
| Web on Windows x64 | 1,834.928 seconds | Four observed intervals of 300.093–300.103 seconds | 8,765 displayed-image changes by the last periodic sample, with 122 distinct sampled JPEG hashes. |

Each sustained session retained one client ID across acknowledged starts and
renewals. Additional starts were acknowledged with the retained session
identity. These counts describe client delivery and sampled image changes.
The existing distinction between request cadence and camera source FPS applies.

Electron transport observation used a temporary utility-entry observer around
the production WebSocket/fetch APIs. Fault injection closed that socket and
interrupted image reads briefly. Web used browser offline mode for the short
interruption. Both hosts retained the displayed image and recovered inside the
30-second budget. Separate physical cases exhausted the recovery budget,
exposed Retry and resumed viewing with a new resource. Device switching was
tested by selecting a configured offline route and returning to the same U1.
Electron minimize/restore and Web background-tab/foreground transitions
released and resumed their views. Explicit Stop, leaving/returning to Monitor
and document/application closure were also exercised. Monitor status remained
live after the recovery and visibility cases.

The two application instances viewed concurrently. After Electron stopped and
closed, Web delivered another 100 displayed frames over 20 seconds and the
displayed JPEG hash changed. This qualifies that bounded two-Neo-client case
on the recorded firmware. Vendor-client coexistence, general hardware viewer
limits and device-wide capture shutdown require further qualification.

Web used `http://127.0.0.1:4173` with direct HTTP/WS device access, default
browser permissions and ordinary CORS enforcement. The harness applied no
transport-security bypass. A separate browser case supplied an incompatible
CORS origin on image responses, verified camera-unavailable/Retry presentation
while Monitor remained live, then restored valid CORS and retried successfully.
Public HTTPS deployment, its mixed-content/local-network authorization path,
API-key-authenticated hardware and encrypted-image delivery require their own
qualification. The recorded run establishes the empty-key, plain-JPEG path.

The utility observer was removed before fixture regression. Software acceptance
covers repository tests/typechecks, renderer CSS smoke, the primary Electron
application journey and Electron/Web camera fixtures. Resource-dependent
object-package checks and real-WASM-only DRC, STEP and native G-code event
checks follow their existing artifact gates. The testing-guideline handoff
scope applies to this feature. The full dual-WASM/platform release matrix
remains a release qualification activity.

## 9. Remote files, previews and transfers

Model storage, directories, remote files and file content identity explicitly.
Files include uploaded printable artifacts, timelapses, recordings, images and
unrecognized content. Metadata describes name, format/media type, size and
timestamps when known, with type-specific information such as printable
material keys, duration and dimensions. Storage availability and capacity/free
space are independent of file metadata and may be unknown.
The proposed remote reference is scoped to printer, route and storage. A
filename or host-private filesystem path alone is not a portable identity.
References retain configuration context; an edited endpoint cannot silently
redirect a stale file reference to another device. Media and operation records
likewise retain their original resource context.
Cross-route reuse needs verified identity and access; route-scoped references
are one way to enforce this rather than a permanent ban on such reuse.

Paged listing is proposed for large collections, with an explicit distinction
between stable snapshots and best-effort enumeration. Cursor and paging
mechanisms are open. Expired cursors, unavailable storage and
file changes are explicit outcomes. File change notifications can invalidate
directories or storage lists. Invalidation followed by refresh is the proposed
baseline; validated domain deltas are another possible design. Consumers must
not reconstruct authoritative state from guessed event details.

Differentiate thumbnail/image, video, text and toolpath previews. A G-code
thumbnail is not a full toolpath preview. Preview options depend on the file,
adapter and client; parsing/format failures remain visible. Viewing a remote
G-code file is read-only and must not replace the current project or its retained
slice result. The [G-code Preview specification](G-code%20Preview%20v2.md) owns
the established toolpath presentation behavior; a separate viewing context is
required when remote content is integrated.

Preview support includes an independent option query from an explicit file
selection, even when file-stat support is unavailable. This query is the single
owner of preview options; general file metadata does not duplicate them. Its
result carries the assessed file identity and available options; an
empty option list means the file has no preview, while query failures remain
explicit errors. Opening uses that file selection and option identity, with
client media negotiation, and revalidates access and option support at execution
time. Option IDs are scoped to the file and configuration, not a prior query
session; a fresh service reference can use them without hidden caller state.
They do not assert that the remote file's contents remain unchanged.

Download, delete, preview and print are independent operations. Only supported
printable artifacts can be started; timelapse playback does not confer print
eligibility. Reprint uses the same start-job semantics as starting a newly
uploaded file, with current material bindings, job options and preconditions.
Do not introduce a parallel reprint command with weaker checks.

The selected Storage design abandons remote-file content version checking.
Download, delete, preview and print act on the currently addressed remote file;
replacement at the same path does not produce a client-side version-conflict
veto. Do not add pre-operation stat, timestamp, size or hash comparisons solely
to detect such replacement. Existing metadata reads needed for browsing or print
preparation remain, but do not provide an unchanged-content guarantee.

The TypeScript contract uses `RemoteFileRef` directly for reads, previews and
start/delete commands. File-content revision fields, comparison capabilities and
strict/best-effort selection modes are removed across producers, consumers,
adapters and compile-time fixtures; no parallel legacy payload is accepted.
Retain printer, storage, route, configuration and authorization checks so an old
reference cannot target a different device after configuration edits. Retain
transfer-length and protocol integrity checks to detect incomplete/corrupt reads;
those checks do not compare the file against an earlier listing version. Normal
missing-file, access and format errors remain explicit.

Upload can address an adapter-defined default destination from local type/configuration,
without first listing storage or directories. Explicit directory selection
remains available where supported. Upload-only adapters need not implement file
browsing. No connection or unrelated device preflight is required.

Uploads report transfer progress separately from device confirmation and return
the actual remote artifact identity. Upload completion does not imply print
start. If start fails after upload, retain the artifact and allow a start-only
retry after a definite failure as required by the console spec. Collision
handling explicitly supports reject, rename and overwrite. Each destination
advertises the policies it implements; callers must select one of them.
Overwrite is a normal capability, not an alias for reject/rename or an implicit
fallback. An uncertain result must be reconciled before retrying.
Cancellation or an uncertain outcome must not claim that remote data was cleaned up.

Large transfers need bounded resource use. Downloads use the streaming and
host-save boundary selected below; exact chunk transport and small-payload
handling remain implementation work.
Report actual ranges and byte counts; unsupported range requests must not masquerade
as successful partial responses. Temporary preview URLs/content handles have
managed lifetimes rather than permanent configuration ownership.

### 9.1 Device Storage and host-owned downloads

**Decision status:** The provider-neutral Storage architecture and separation of
agent file reads from host download/save tasks are selected. Bambu is the first
agent to implement this feature. The initial delivery includes file management,
device-file printing, in-app playback while downloading, and completed-file
opening with the system application. Product and architecture choices below are
selected and implementation is authorized in independently verified increments.
The scoped-file contract migration and initial shared Storage browser are
implemented. The browser resolves storage on explicit entry, loads snapshot pages,
filters/groups loaded entries, and maintains explicit scope-bound selection.
Renderer/preload/main fixture E2E passes; utility routing/session and native
protocol fixtures are tested separately. Registered desktop download tasks now
include destination selection, progress, cancellation/retry, saved-file opening,
startup cleanup and close coordination. Confirmed single/batch deletion is also
implemented through the existing command/operation contract. Optional, visible-card
thumbnail resources and independent remote print inspection/preparation/dispatch
are implemented within fixture acceptance. Stored-video progressive playback now
has generated AVC acceptance through real Electron main/preload/utility ports.
Same-printer LAN authorization recovery is integrated through the existing
provider discovery/authorization contract. Physical qualification remains pending.
The host-neutral [managed stream executor](../packages/printer-control/src/downloads.ts)
is implemented independently of host IPC and filesystem bindings: it consumes
one owned chunk at a time, waits for each sink write and terminal reader checks,
then publishes. It joins cleanup on failures/cancellation and reports the actual
publication outcome when cancellation races finalization. The desktop task facade
uses this executor through a private main/utility protocol.
The host-neutral [transfer admission queue](../packages/printer-control/src/transferQueue.ts)
implements FIFO per host-resolved physical printer, a configurable global active
reader bound, cancellation that joins the executor, and explicit retry/continuation
of a blocked head. Different routes must resolve to the same physical key in the
host. The desktop registry admits Bambu downloads to this queue with a provisional
global limit of two readers. Stored-video opens use the same queue and physical
identity resolver; complete local caches release their reader slots while retaining
the viewing lease. Queue fixtures cover mixed admission and cancellation. Physical
mixed download/playback admission remains unqualified.
The [managed task engine](../packages/printer-control/src/downloadTasks.ts) now
tracks batch/task identity, attempt-scoped progress, private saved receipts,
isolated failure continuation and blocked-head retry/acknowledgment. Its public
[task contract](../packages/platform-contract/src/printer/downloadTasks.ts) contains
no destination paths and distinguishes managed saving from browser handoff.
The [desktop registry](../apps/desktop/src/main/printerDownloads.ts), destination
dialogs, private utility execution/progress, public task IPC and application-close
coordination are implemented. Shared UI owns task presentation and completion/
failure notices. The Web host uses the same task engine for U1 with browser-granted
file handles. It reports managed downloads unsupported when the browser lacks
the File System Access pickers.
Renderer/preload/main fixture E2E covers page navigation and task cancellation;
separate executor tests perform actual file writes, and registry tests cover
admission and shutdown. This is not real-printer or packaged-platform qualification.
The desktop [filesystem sink](../apps/desktop/src/utility/downloadFiles.ts) is also
implemented and tested with actual filesystem writes and process-exit recovery.
It writes to a same-directory temporary file, publishes confirmed replacements
with rename, and uses exclusive hard-link publication for ordinary downloads.
Filesystems without hard-link support currently fail publication explicitly;
support for such destinations needs a separate no-replace publication mechanism.
The app-owned journal identifies orphan output for cold-start cleanup. Calling
recovery through the utility execution initializer checks both recorded parent and
worker PIDs before cleaning an old session, preserving other live app instances.
The utility joins active cancellation and file cleanup before closing its journal.
Main initializes recovery at startup and reports failed/ignored records; download
shutdown precedes utility shutdown. Unexpected utility exits reject pending calls
instead of leaving tasks waiting forever.
The [Bambu storage command owner](../apps/desktop/src/utility/bambu/storageCommands.ts)
uses CTRL deletion without acquiring the selected MQTT Monitor lease, probing file
content or consulting local transfer/print activity. Existing command request IDs
provide instance-local deduplication. Explicit device rejection is a failure;
transport or inconsistent-response outcomes remain unconfirmed. Shared batch UI
continues after isolated failures, pauses after shared/uncertain failures and
never re-queries or resends an uncertain deletion. Confirmed results remove only
the affected local entries and invalidate old pagination; manual refresh starts
a new snapshot. Native, command-owner, shared UI and renderer/preload/main fixture
tests cover these boundaries; no physical files have been deleted for acceptance.
Optional [storage images](../apps/desktop/src/utility/bambu/storageImages.ts) use
`files.listPreviews` and the existing managed-media contract. Visible cards admit
eight reads at a time. The [shared frontend thumbnail cache](../packages/slicer-app/src/components/device/media/ThumbnailCache.tsx)
retains independent image snapshots (including explicit missing-preview results)
for the current browser session. Scrolling away releases the visible consumer;
returning, filtering and regrouping reuse cached images without another
`listPreviews` or `media.open`, and therefore without another agent resource read.
Concurrent consumers of the same exact file/preview reference share one pending
read; cancellation aborts it only after the last consumer leaves. Provider media
leases close immediately after copying; scrolling does not keep agent resources
alive. Immutable PNG/JPEG data URLs can be retained directly. Other image delivery
URLs must be renderer-fetchable under the host's origin/CORS/CSP policy and are
copied to browser-owned Blob URLs before lease release.
The common cache supports all agents; agents do not implement thumbnail caching.

Each browser cache targets 256 entries and 32 MiB of retained image bytes
(conservatively counted as UTF-16 for inline URLs). These are retention targets,
not image acceptance limits. Inactive least-recently-used entries are evicted;
displayed images and pending reads are pinned and may exceed either target.
Releasing a consumer trims eligible entries again, including an oversized image
when its last visible consumer leaves. There is no per-image source-size limit.
Eviction can require a later remote read. Object URLs are revoked on eviction or
cleanup. A successful first-page reload/manual refresh, printer/route/configuration
or storage/collection switch, and leaving the browser clear the cache. Pagination
does not clear it. File/preview keys include the full opaque file reference; there
is no content-version probe. Transient failures are not cached as missing images.
The cache is memory-only, never persisted or logged, and does not cache video
playback, live camera streams or full files.

The Bambu host coalesces up to eight resources per SUB_FILE request, deduplicates
identical resources within that batch and serializes batches per route/configuration.
Two host resource connections are allowed globally, reused across sequential
requests and closed after a two-second idle lease. Shutdown, cancellation of all
batch consumers, transport/protocol failure and configuration/auth changes close
and join the affected native reader. Independent consumers retain their own leases;
cancelling one consumer does not abort another consumer's shared batch.
Queued resources are bounded to 64; resource contents have no application byte
or packet-count budget. The Bambu host adds
no file-content cache or automatic failed-file retry. A terminal per-file SUB_FILE error
preserves completed resources, leaves that file as a placeholder, and continues
only entries not yet read, using a new request sequence on the same connection.
Bambu reads the relationship document and its selected PNG/JPEG through
SUB_FILE, or a video's `#thumbnail`; it does not download the archive to fill a
missing thumbnail. The pinned plugin's FTPS fallback returns empty optional
subfiles, so that path deliberately retains placeholder images. Reads retain a
30-second per-batch deadline and inactivity timeout. No relationship/image size,
decoded-dimension, native Storage packet-size or aggregate image-byte limit is
added to Orca behavior. The host identifies PNG/JPEG delivery MIME types and the renderer
decodes the actual image. Native Storage reads retain demand-based queue
backpressure rather than rejecting a packet for its size. Utility images have
document ownership, cancellation before or during open, and expiring leases.
These lifetimes are separate from the live camera and independent save tasks.
The utility's 128-entry request deduplication history evicts the oldest terminal entries under pressure;
completed/released/missing-image requests never impose a cumulative browsing quota.
Pending reads and live image leases are protected from history eviction and expiry,
including renewed leases. Closing a document clears its request history. This is
bounded operation bookkeeping; thumbnail content caching remains in the shared
frontend browser.

Thumbnail acceptance covers resources beyond the former byte/packet budgets,
large relationship documents, utility ownership/MIME negotiation, viewport cache
eviction/cancellation and lease release, and actual image decoding beyond the
former 4 MiB/4096-pixel thresholds in the Electron
fixture and existing live-camera E2E. The default parallel native suite repeated
an existing `camera.test.mjs` startup failure (`No fixture samples`); the isolated
camera suite and complete serial suite passed. A subsequent unchanged parallel
run also passed. This is an intermittent test result, not a diagnosed/fixed camera
problem or evidence of physical thumbnail support.

Read-only H2D performance acceptance on 2026-11-03 used the same printer, files,
LAN and macOS development host as the earlier Storage round. The first visible
model viewport contained seven available thumbnails and five missing resources;
all seven available images were retained after the optimization. From Storage entry,
the last available model thumbnail changed from 27.183 seconds to 4.104 seconds;
the optimized listing was ready at 2.798 seconds, leaving 1.306 seconds for the
thumbnail stage. Twelve visible timelapse thumbnails changed from 14.634 seconds
to 1.344 seconds with a reusable connection; a cold connection refresh took
2.353 seconds. These are observed single-host runs, not latency guarantees or an
Orca wall-clock benchmark. The implementation comparison with Orca is from source:
Orca batches SUB_FILE paths on its existing browser connection. No remote deletion,
print submission or full-file thumbnail fallback was used. Normal-speed timings
do not qualify end-to-end plugin buffering or a slow-consumer memory bound.

The [remote-print bridge](../packages/slicer-wasm/src/bridge_remote_print.cpp)
now wraps Orca's `load_gcode_3mf_from_stream` without accessing live project state
or activating presets. The runtime packages the requested resources into a ZIP and delegates format
acceptance to Orca's parser. Inspection adds no separate resource allowlist,
required-file preflight, archive/expanded-size, entry-count, plate-count or
material-count rejection. The agent and SUB_FILE reader likewise impose no
per-resource or aggregate metadata budget on this path. Thumbnail reads also
add no content-size budget; thumbnails remain separately
owned image resources. A disposable desktop Worker serializes inspection, bounds
pending admission, terminates on timeout/cancellation and joins teardown before
the next request. Focused real-threaded-WASM smoke covers two plates, repeat
inspection, Orca-compatible larger resource bundles and malformed ZIP cases. This parser boundary alone does not
enable remote print preparation or physical submission; those integrations remain
separate acceptance requirements.
The native wrapper also exposes `start_sdcard_print` as the host-private
`device-file` print mode, with remote-path/plate admission instead of a local
upload filename. Its pinned v2.2.0 Sending callback precedes MQTT publication;
post-dispatch failures remain uncertain and close joins the in-flight call.
Native fixtures verify ABI routing and lifecycle, not physical printing. The
[pinned implementation](https://github.com/ClusterM/open-bamboo-networking/blob/v2.2.0/src/print_job.cpp)
uses the project basename for the wire file name despite requiring `dst_file`;
the agent must reject names that this normalization would change.
The shared `remotePrints` service dispatches inspection/preparation/release by
provider-owned file identity. Bambu fetches metadata subfiles, owns the
resulting 30-minute inspection context, and resolves a selected target back to
its own requirements before reusing material/option validation. Renderer-supplied
requirements and native paths are rejected at IPC admission. Missing subfiles do
not trigger a full archive download. Ambiguous nozzle mappings block that target;
missing thermal/hardness metadata requires an explicit print warning. Contexts
are bounded and released explicitly or evicted/expired; they do not attest to
remote content freshness. `jobs.start` now accepts the inspected target and
normal print options/bindings. Bambu re-resolves agent-owned requirements,
requires current warning acknowledgement, and shares print admission with local
artifact sends. The device-file path never stages/uploads an archive and never
falls back by resending an uncertain start. A `submitted` command outcome means
the provider returned a successful send receipt, not a device acknowledgement or
physical-print confirmation. Connection-time configuration/state is rechecked
before dispatch. Shared Storage now exposes single-file inspection and target
selection, reuses the material/options presentation with an independent remote
source hook, and releases inspection/image resources on close. Agent-issued plate
thumbnail options resolve only against that exact file and inspection. Renderer
fixtures verify that no project read/export is invoked, unknown starts cannot be
resent, and late contexts are released. Electron fixture E2E covers second-plate
selection, actual thumbnail decoding and submitted-command navigation. Physical
device-file printing remains unqualified.
The [Storage interaction design](Printer%20Console%20and%20Control%20Integration.md#device-storage-design)
owns the feature envelope and user-facing decisions.

#### Selected ownership boundary

Shared Storage components use the existing printer service and its capability
model. Storage names, file kinds, optional directories and supported actions are
provider data. Future agents implement the same contracts and register with the
dispatcher; they do not require separate Storage pages or save implementations.
Bambu protocol details do not enter shared React components.

The selected cross-host architecture separates an environment-independent task
engine, provider file readers and host save adapters. Utility processes, Node
filesystem handles and Electron IPC are execution bindings, not shared-domain
requirements. First delivery implements Electron execution; browser save adapters
and a Web-to-native gateway are future work, not implicit deliverables.

Model browsing capabilities per storage: supported content kinds and actions,
and collection-based or hierarchical browsing. The shared contract must support
both browsing modes without inventing a directory tree for Bambu or flattening
future agents' real directories. Bambu collection browsing is the initial UI;
directory navigation is delivered with the first agent that requires it.
`PrinterStorage.browsing` now describes a collection catalogue or directory scope
with content kinds and action IDs. `ListFilesRequest.location` selects exactly one
collection or directory. Both removable SD storage and
internal storage are in the initial Bambu scope where supported by the device.

Resolve unknown Storage capabilities on explicit page entry through one bounded,
agent-owned attempt when needed, then list supported resources. Failure exposes
manual retry without background probe loops. Do not collapse unknown capability
into unsupported, and do not initiate this work during startup or passive printer
enumeration. Explicit `listStorages` returns the resolved per-storage browsing
capabilities; it is not a passive device-enumeration call.

The independently tested [Bambu file adapter](../apps/desktop/src/utility/bambu/storageFiles.ts)
maps protocol entries to stable scoped references and snapshot pages. Cursor scope
includes device, route/configuration, storage, collection/filter and page size.
Snapshots expire after five minutes and are bounded to eight retained listings and
50,000 entries overall; one native listing is limited to 20,000 entries. Confirmed
deletion invalidates affected paging snapshots. The
[session binding](../apps/desktop/src/utility/bambu/storageSessions.ts) resolves only
same-device authorized LAN credentials, bounds outstanding native requests, and
joins stream return on cancellation, authorization changes and shutdown. It does
not acquire the single selected MQTT monitor lease. Storage visibility separately
uses reported Bambu capability bits: reuse a fresh same-route context, otherwise
attempt one temporary status read that releases its lease. It does not displace
another monitored printer. A cold direct internal-list request can resolve missing
capabilities without prior discovery; subsequent internal lists reuse the report
without acquiring a status lease. When that read is unavailable, retain known same-route
capabilities or conservatively offer External only. Capability refresh does not
make binary reads depend on an active Monitor. The runtime and renderer
provider now register metadata-only Storage RPC, including read cancellation.
The [shared browser](../packages/slicer-app/src/components/device/PrinterStorage.tsx)
uses that provider through the normal printer dispatcher. The
[Electron browser fixture](../apps/desktop/e2e/bambu-storage.e2e.ts) verifies entry-only
discovery, filtered loaded selection, pagination and storage switching through real
renderer/preload/main IPC; it does not run a physical printer or qualify the native
utility transport. Full Storage delivery remains incomplete.

Browsing refresh is request-driven: load on entry or scope changes, allow manual
refresh and update after mutations, without periodic list polling. Bulk selection
contains explicit file references from the loaded, currently filtered results,
including offscreen rows. It must not enumerate additional pages, select future
page results implicitly or recurse into other directories. Changing printer,
storage, collection or directory clears selection but does not cancel admitted
download tasks. The contract boundaries below define cursor scoping and
refresh-time reconciliation; concrete cursor encoding remains adapter-owned.

The [file domain](../packages/platform-contract/src/printer/files.ts) owns remote
selection, metadata and binary reads. Keep `PrinterFiles.download` as a read
operation returning `DownloadedFile`/`BinaryRead`, including actual byte counts,
range information and an asynchronous sequence of owned byte chunks. The agent
owns protocol decoding, protocol-specific integrity validation and cancellation
of its read. An integrity or transport failure after admission terminates the
stream with an explicit domain error. A destination filesystem path is not an
agent input. File references retain their printer, route, storage and
configuration context independently of the active UI selection.

A host-injected, provider-neutral download service owns saving a remote file.
It resolves the source provider, chooses the destination through host facilities,
consumes the agent stream, manages temporary output, and exposes task progress,
results and cancellation to shared UI. Only successful stream completion and
successful file publication establish a completed desktop download. Destination
paths and file handles remain host-private, except for the default-directory
display metadata in Preferences. Desktop ordinary downloads use the
configured default directory, preserving existing files through numeric filename suffixes.
This is one application-wide host preference shared by every agent, exposed under
Preferences → Downloads. The desktop host retains the existing private
`downloads/download-directory.json` setting, so moving the UI preserves previously
chosen directories. Preferences shows the full currently configured directory
path, or the OS Downloads path when no custom directory is saved. The chooser
returns the full selected path as display-only metadata and an opaque draft-selection
ID without changing that setting. Preferences Save commits the selection; Cancel
leaves the saved location unchanged. The host retains at most one pending
selection and rejects superseded or unknown IDs. Filesystem operations continue
to resolve that ID in the host rather than accept the displayed path, and
a failed write leaves the selection available for retry. No default destination is stored in per-printer configuration,
agent credentials or renderer-visible user preferences. The shared Preferences UI
uses the provider-neutral download service and explains browser-managed saving on
hosts without managed-download support.
Save As selects one file destination or one batch directory; replacement of an
existing explicitly selected destination requires overwrite confirmation. The
host owns collision resolution, including conflicts between concurrent tasks;
the agent does not generate local destination paths. Failed or canceled initial
delivery downloads clean up temporary output, and retries begin at byte zero.
Interrupted-download resume is deferred; media range reads do not imply it.
Publication and cleanup follow the ownership rules below; the desktop filesystem
adapter implements these operations, while host routing and recovery lifecycle
integration remain implementation work.

Batch results distinguish successful, failed and canceled items and support
retrying failed items. Continue past isolated file failures; pause the affected
queue for shared source/destination failures such as disconnection or disk
exhaustion, with explicit recovery feedback before user continuation. Do not
report an incomplete batch as successful or equate queue continuation with
resuming a file from a byte offset. Error classification and exact task state
transitions still need specification.

Initial scheduling serializes explicit file downloads per physical printer and
shares that printer's transfer slot with stored-media reads. Admission is strict
FIFO across explicit download and playback requests, with no playback priority
over earlier queued downloads. Canceling a request removes that request without
reordering the remaining queue. A second request waits without automatic
preemption; the user may explicitly cancel earlier tasks. Cancel queued playback
when its viewing context closes. Active playback holds the slot while it may still read remote data, including buffering
or awaiting a seek; playback entirely from completed local cache needs no remote
slot. Different printers may progress independently subject to host resource
bounds. Key this scheduling to physical printer identity, not the currently
selected route, so multiple routes do not bypass the limit. Provider-specific
parallel transfer capability is deferred. Queue continuation and small-request
coordination follow the contract boundaries below; adapter transport scheduling
and measured global resource bounds remain implementation work.

Admitted download tasks belong to the host rather than a mounted Storage page
or active printer selection. Leaving the page or switching printers does not
cancel them. Task management is exposed within Storage, with completion/failure
notifications outside it, rather than a global download panel. Closing the last
desktop window or explicitly quitting with unfinished tasks prompts for returning
to wait or canceling and closing. The host cancels reads and cleans temporary output
for confirmed normal closure; it does not remain headless solely to finish
downloads. Unsuccessful cleanup must be surfaced. Shutdown coordination and
crash recovery remain execution-design work, not a promise of durable resume.

The proposed UI facade has start, observe and cancel operations on opaque task
references. Exact method and serialized state names are finalized with the
contract implementation; the required task semantics are recorded below.
This facade orchestrates `PrinterFiles.download`; it does not introduce a second
vendor-specific download protocol or replace the remote-file domain. The existing
whole-buffer export/save interface remains a separate capability for its callers.

```text
Shared Storage UI -> injected download service -> common task engine
                                                  |            |
                                           provider reader   host save adapter
                                                  |            ^
                                                  +-- chunks --+
```

Electron hosts the reusable download executor and filesystem sink in utility
execution. Main owns destination dialogs, trusted host routing, cross-window task
coordination, physical-printer transfer admission and shutdown coordination;
shared UI receives task state rather than file contents. Instantiate actual
provider readers in their execution host. The current renderer-side provider
registry contains proxies and is not implicitly available in main or utility.
Reuse the public read contract and protocol implementation through explicit host
registration rather than attempting to send provider objects over IPC.

Initially the common executor can be composed into the existing Bambu utility
alongside its native reader. Future agents register readers and execution hosts
and reuse the same executor module; compatible agents may share a host, while
native dependencies may require isolation. Neither one process per agent nor a
single universal utility process is required. Co-locating reading and writing
avoids unnecessary byte transfer on desktop but is an optimization, not a domain
invariant. Local destination access belongs to the save adapter, never the agent
reader. No slicing runtime is required for listing, downloading or deletion.

`AsyncIterable` and `AbortSignal` describe the local SDK, not IPC messages.
An out-of-process reader needs an explicit binary transport binding, ownership,
flow control, cancellation and termination semantics. An in-process HTTP reader
can supply the same stream directly. Exact IPC framing and resource ownership
still need specification. Native reader backpressure must be qualified even when
reading and writing are co-located; process placement alone does not bound plugin
queues.

Agent execution location and user save destination are independent. A future
browser-direct HTTP agent runs only where browser networking and authentication
permit it. Bambu's native reader requires a native execution host, exposed to Web
through a future local helper or remote gateway using the same domain semantics.
A browser-side proxy converts network delivery into the local read contract;
neither `AsyncIterable` nor a native filesystem handle is a network DTO. Completion
of a gateway read or server-side staging is not completion of saving on the user's
computer. The executing agent host owns applicable transfer admission; the shared
engine cannot rely on Electron main to exist in every deployment.

Save adapters advertise their actual guarantees. Managed streaming save reports
completion only after successful read and destination finalization. Browser
download handoff reports a distinct handed-off result, without claiming verified
local completion or equivalent cancellation/collision/cleanup control. Exact
state names remain open. Destination selection, overwrite handling, external
player launch and window-close coordination are host capabilities: the selected
desktop UX is not an unconditional browser requirement. Do not turn the current
whole-buffer export API into an unlimited-memory fallback for large or unknown-
size remote files. Browser streaming save, browser-managed download delivery and
unsupported/limited cases need explicit capability handling. Mobile remains
deferred.

#### Initial Bambu direction and reference behavior

Bambu presents logical `external` and `internal` storage IDs, independent of the
raw names returned by CTRL discovery. Browsing visibility does not issue the
CTRL media-ability enumeration; it follows the reported capability flags. External is first and is listed without a
`storage` wire selector; Internal uses `storage: "internal"`. The current agent
advertises internal model/timelapse collections only for the respective reported
capability, never from the presence of `emmc` alone. Optional internal discovery
is not a successful listing qualification; printer rejection remains visible.

Use the existing pinned `open-bamboo-networking` v2.2.0 artifacts and extend
`@orca/bambu-native`'s BambuSource CTRL integration. Orca's
[PrinterFileSystem](../packages/slicer-wasm/cpp/src/slic3r/GUI/Printer/PrinterFileSystem.cpp)
and [MediaFilePanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/MediaFilePanel.cpp)
are the reference for file operations and interaction. The pinned plugin's
[capability account](https://github.com/ClusterM/open-bamboo-networking/blob/v2.2.0/STATUS.md#printerfilesystem-mediafilepanel)
records list, subfile/thumbnail, download, delete, storage discovery and task
cancellation primitives. Its actual execution is LAN-based, including eligible
cloud-paired printers with usable LAN access. True remote cloud file browsing
is not provided by this pin. On explicit Storage entry, reuse existing authorized
LAN address and credential information belonging to the same physical printer,
without requiring the user to add a separate LAN connection. Prompt for missing
access information. This does not authorize credential reuse across devices or
retarget existing file references; reads retain their resolved route and
configuration context. Account login or Cloud enumeration alone does not prove
access. Missing authorization now exposes a Storage recovery action through the
shared discovery/authorization UI. It starts discovery only on explicit request,
filters candidates by provider/host and external physical identity, and submits
`existingPrinterId` with transient masked input. The Bambu provider independently
checks the candidate against current discoveries and the existing printer ID.
Success updates access on the existing device, then refreshes Storage; it does not
create a second printer entry or expose stored access codes. Recovery permits an
explicit replacement code. If the same printer is not announced locally, show
network/power guidance and keep waiting; manual IP entry is not implemented by
this provider flow. Orca's `MediaFilePanel::fetchUrl` instead invokes its existing
IP-entry dialog when local addressing is missing. These are distinct recovery
interfaces; neither Cloud login nor an announcement grants file access.

Orca receives download chunks on a C++ worker thread, writes them synchronously
to an output stream and accumulates MD5, then reports progress to its UI. Its
file-browser download queue advances one file at a time. This path writes the
destination filename directly; temporary-file publication is a Neo design
decision, not an existing Orca guarantee. Orca's receive loop has no equivalent
of Neo's current short resource reader's 20-second total lifetime.

Storage downloads have separate connection-establishment and no-effective-progress
timeouts, not a total per-file deadline while valid data continues to advance.
Do not treat keepalives or repeated non-advancing responses as file progress.
User cancellation remains available. Distinguish deliberate downstream flow-control
pauses from source inactivity, and report sink stalls separately rather than
misclassifying them as printer disconnection. Exact timeout values and stalled-sink
handling require slow-link and device qualification. Preserve the existing bounded
current-project reader's purpose instead of globally removing its limits.

The [native CTRL reader](../packages/bambu-native/native/control.cpp) now requires
an explicit purpose. The [current-project resource adapter](../packages/bambu-native/src/control.ts)
retains its allowlist, size limits and twenty-second native lifetime. Storage mode
has no total transfer deadline and bounds its incoming queue to two packets, each
at most 4 MiB, pausing native pulls while that queue is full. The
[Storage file reader](../packages/bambu-native/src/storageDownload.ts) validates
offsets, total length and terminal MD5, exposes single-consumer owned chunks and
joins closure on cancellation/early return. Its separate connection and demanded-read
inactivity timeouts do not count time spent waiting for the consumer to request
another chunk. Timeout values remain host configuration requiring qualification.
The [Storage query adapter](../packages/bambu-native/src/storageQueries.ts) adds
explicit media-ability discovery, bounded multipart collection listings and one-file
deletion with response validation. Listings are deterministic, reject duplicate or
incompatible entries, and have an overall request deadline independently of stream
inactivity. Delete requests have no local playback/printing veto and do not retry;
transport or inconsistent acknowledgment leaves the outcome uncertain for the host.
Native fixture tests cover a progressing transfer exceeding twenty seconds,
consumer pauses, cancellation, malformed data, zero-byte output, listing assembly
and deletion acknowledgment; all 39 native tests pass on macOS arm64. An earlier
full run had an existing camera fixture sample-acquisition timeout that did not
recur on a no-code-change rerun; its cause is unconfirmed. These tests do not
qualify physical Storage reads or deletions. Registration with the utility/provider
and UI remain separate work.
The pinned plugin's internal response queue has no
explicit capacity limit in its
[implementation](https://github.com/ClusterM/open-bamboo-networking/blob/v2.2.0/stubs/BambuSource.cpp).
Host-side flow control alone therefore does not establish end-to-end bounded
memory. Large-file, slow-sink and cancellation behavior need qualification;
these source findings are not evidence of an observed device failure or approval
to upgrade the plugin.

Deletion uses the existing `controls.submit(files.delete)` operation and scoped
file selections. Confirm single and batch actions in the UI, then submit without
an additional client-side in-use veto based on downloads, playback or known
printing activity. Device execution decides whether the file may be deleted;
do not synthesize an in-use rejection solely from those local observations or
automatically stop reads/printing to make deletion possible. Preserve ordinary
capability, authorization and reference validation. Concurrent reader failures
are independent task outcomes. This selects Orca-like submission behavior, not
its error-reporting semantics. Preserve uncertain deletion outcomes explicitly:
retain affected entries with an unconfirmed result and wait for user-initiated
refresh, without an automatic verification read or mutation retry. This overrides
the ordinary post-mutation list update rule for uncertain deletion outcomes.

Continue a deletion batch after isolated, explicit per-file failures, but pause
remaining work on disconnection or uncertain results. Distinguish confirmed
success, explicit failure, unconfirmed outcome and not-executed items, without
rollback of confirmed deletions. Normalize only the certainty available from
the provider response; an ambiguous aggregate response cannot establish each
file's outcome. Manual refresh reports current presence, not retrospective proof
that a particular deletion request succeeded. Exact aggregate-result mapping and
user-continuation mechanics remain to be specified.

#### Contract implementation boundaries

The product decisions above are selected. The following contract work makes
those decisions executable; existing source types remain authoritative for what
is implemented today. Change each internal producer, consumer, adapter and test
together, with no compatibility aliases or parallel old/new payloads.

| Boundary | Required contract behavior |
| --- | --- |
| Storage discovery | Represent each storage's browsing mode, supported collections/content kinds and available operations. Capability resolution is an explicit bounded read; local description and saved-device enumeration must remain free of network probes. Unknown support and unavailable media are not empty successful listings. |
| Listing and selection | Opaque cursors belong to a printer/configuration/storage/query scope and identify snapshot versus best-effort enumeration. Invalidate incompatible cursors instead of mixing pages from different scopes. Preserve deterministic ordering within a listing and use stable file identities for deduplication. Bulk selection is an explicit set of loaded filtered references, never an implicit all-pages predicate. |
| Remote-file identity | Remove content-version fields, comparison capabilities and strict/best-effort file-selection modes, including those in preview, upload results and start/delete commands. Retain device, route, storage and configuration provenance. Content integrity of a transfer is a separate concern. |
| Download service | Expose destination intent, opaque task/batch references, current snapshots, observation and cancellation. Snapshots carry source display metadata, byte progress with unknown totals allowed, waiting/running/finalizing/terminal state, actionable errors and actual cancellation ability. Host paths and credentials are not shared UI task fields. |
| Host registration | Resolve a validated printer/provider reference to an execution host and a reader factory; inject credential access, parser service and save facilities through their owning boundaries. Do not use a renderer proxy registry or a filename extension to choose executable provider code. |
| Print preparation | Generalize the source of preparation requirements to distinguish a retained local slice from an agent-inspected remote file/print target. Remote inspection returns target-scoped normalized metadata and supported actions, with absent information explicit. Reuse material/options validation without fabricating a local slice receipt or requiring all agents to expose Bambu-specific metadata. |
| Print start and deletion | Extend the single existing command contract as needed for a selected print target and shared print options. Continue through `jobs.start` and `files.delete`, using their operation tracking and current-device guards, rather than new vendor-specific mutation paths. Do not add an in-use veto for deletion. |
| Stored media | Reuse independent preview-option and managed-media boundaries; negotiate actual codecs, progressive playback and playable seek ranges. Browser/desktop media delivery bindings may differ. Neither a video extension nor remote byte-range support alone establishes playability. |

Task cancellation ends the read and destination ownership for that task, not a
physical print job. Cleanup is part of task termination; retain an actionable
failure when cleanup cannot finish rather than reporting clean cancellation.
Waiting work has not acquired a remote read. A retry creates a new attempt from
byte zero with current device/configuration validation; it does not resume old
bytes, silently retarget a device or automatically repeat an uncertain mutation.
Track attempt identity so late progress or callbacks cannot modify a replacement
task. Batch completion summarizes actual per-item states instead of hiding
partial failure behind one success flag.

A paused per-printer queue does not advance later work around its blocked head;
user continuation or cancellation resolves that head before strict FIFO resumes.
An interrupted download may be retried from the start. Uncertain deletion results
remain unconfirmed until user handling/manual refresh and are not auto-retried.
Small listing/metadata/control requests do not consume a full-file transfer slot
by default: the adapter still serializes or bounds its actual protocol as needed.
In particular the download queue must not introduce a local in-use deletion veto.

Refresh-time reconciliation uses device/configuration and file identity, not file
content versions. Removed identities leave the selection; surviving identities
can remain selected. Late results from a previous printer, storage or query scope
are ignored. Sort/filter/group presentation must not imply that unloaded pages
have been searched or selected. Exact layout and query field names can be chosen
during implementation without changing these selection and paging guarantees.

Remote printing uses the existing start-job semantics with current
material bindings and preconditions. Its source is an independent remote-file
context; the current slice-based preparation hook is not an implementation of
that context. Initial delivery acceptance includes a physical device-file print.

The agent owns supported-format and individual-file printability decisions and
provides normalized print targets, preparation metadata and unavailability
reasons. Shared UI cannot infer printability from file extensions or vendor IDs.
The initial Bambu implementation supports sliced `.gcode.3mf` printing and defers
ordinary `.gcode` printing; this is an agent-specific scope, not a shared format
restriction. Other agents may support direct printing of other formats.

Initial submission selects exactly one print target. A multi-plate artifact
exposes selectable plates with target-scoped metadata; an agent without plates
exposes one target. Keep vendor plate numbering and physical start parameters
inside the adapter. Consecutive/multi-target printing is deferred. Initial
inspection includes thumbnails and available preparation metadata, not full
G-code toolpath rendering. Bambu reuses Orca's C++ sliced-3MF parsing logic through
an injected runtime inspection service with an isolated Worker/context. This
service is separate from the active project's mutable runtime state; inspection
must not import into that project or replace its retained slice result. Keep
Emscripten access inside the existing slicer client/runtime boundary and printer
networking outside it. The agent fetches relevant remote resources, invokes the
parser and normalizes results; shared UI never interprets vendor archive layouts.
Other agents may use their own parsers and need not depend on slicing WASM. The
same service boundary permits an independent Web Worker later. The implemented
runtime packages metadata resources for Orca parsing and returns Orca metadata for
agent normalization; the desktop inspector owns disposable Worker admission and
termination. Physical file-format qualification remains separate.

Stored-media playback consumes an agent-provided read through host-owned media
delivery. The host exposes actual playback/seek capabilities to the shared
player: unrestricted timeline seeking with buffering when both source access
and media indexing support it, otherwise seeking within downloaded playable
ranges. This does not assert range support for the pinned Bambu adapter. Keep
remote download range support, locally cached byte ranges and playable time
ranges distinct. The host owns temporary playback disk cache and media-read
lifetime. Closing the player, leaving Storage or changing printers cancels media
reads and cleans this cache, without canceling independent save tasks or deleting
explicit downloads. Persistent reusable cache and a floating player are outside
the initial scope. Media that cannot progressively play falls back, by user
choice, to explicit download and opening with the system application, not a
full-download-then-in-app attempt. Decoder incompatibility also exposes the
external-player action.

The initial desktop [stored-video owner](../apps/desktop/src/utility/bambu/storageVideos.ts)
uses the common remote reader with a [disk cache](../apps/desktop/src/utility/media/storedVideoCache.ts)
and a bounded [progressive MP4 parser](../apps/desktop/src/utility/media/progressiveMp4.ts).
Its currently qualified subset is fast-start MP4 with one AVC video track and
non-reordered timestamps. Audio, fragmented input, AVI, tail-moov MP4, other codecs
and over-limit inputs expose the explicit download alternative. This is an
implementation qualification limit, not a permanent restriction on other agents
or future media bindings. No full-download retry feeds the embedded player.
The current cache admits two resources, bounds each input/cache at 2 GiB and
bounds headers, sample tables, input chunks and emitted fragments. These limits
need real-file qualification. Each packet is written before its playable range is
advertised. The iterator's terminal length/MD5 checks finish before releasing the
remote reader slot. A late integrity failure stops playback; frames presented
before that point are not proof of a verified complete download.

Media descriptors expose actual `cachedRanges`, separate from source byte-range
support. A stream attachment can start at a cached timestamp; the owner selects
an indexed keyframe and emits fresh initialization. Detaching this finite stream
does not destroy the viewing lease, allowing seek/replay. The shared finite MSE
player stops pulling when ahead of playback or at its byte budget, removes
consumed data and reattaches to disk cache for backward seeking. Renderer memory
is not proportional to file size. This does not prove bounded memory in the
pinned native plugin's internal response queue.

Closing/leaving cancels reads, joins disk I/O, revokes the stream and removes the
owned cache. A process-scoped cache directory supports cold-start orphan cleanup;
live process directories are preserved. Cleanup errors are reported for explicit
close/download transitions. A decoder failure releases playback immediately and
presents an explicit managed download action. It never opens a system application
before the user requests that action on a completed save.
[Generated-video Electron acceptance](../apps/desktop/e2e/stored-media.e2e.ts)
encodes AVC locally, begins playback before the source reaches EOF, checks actual
decoded pixels after a cached seek, and verifies utility cache deletion after
close/navigation. Unit coverage exercises FIFO interaction with downloads,
truncated/over-limit reads, early tail-index rejection and cancellation cleanup.
No physical Bambu video format or packaged-platform matrix is qualified by these
fixtures. The
[Storage interaction design](Printer%20Console%20and%20Control%20Integration.md#device-storage-design)
owns the selected user behavior.

#### Execution and delivery dependencies

Implement the contract migration and deterministic provider fixtures before
wiring UI actions. The host streaming path must then establish owned byte chunks,
bounded application queues, cancellation and destination finalization before
large-file browsing/download integration is treated as complete. Bambu storage
execution extends CTRL alongside the existing current-job resource reader, whose
allowlist and small-resource limits remain scoped to that use case. No slicing
runtime is needed for ordinary file management.

Use explicit stream identity, sequence/offset validation, terminal status and
credit or acknowledgement flow control wherever bytes cross a process boundary.
Credits are reclaimed after downstream consumption rather than merely receipt
of a message. Validate actual response lengths and protocol integrity, distinguish
unknown totals from zero bytes, and release native sessions, IPC endpoints and
file handles on every terminal path. Main and shared React must not accumulate
file-sized buffers. Fixed queue/cache budgets and chunk sizes belong to validated
host configuration; do not invent acceptance values before measuring the pinned
native path under slow consumers.

Desktop saving writes to a uniquely owned temporary file in the destination
filesystem and publishes only after successful stream completion and writer
finalization. Reserve collision-safe names across concurrent tasks and recheck
publication conflicts; an unconfirmed late collision must never silently overwrite
a file. Confirmed Save As replacement preserves the original until publication.
Cleanup removes only files owned by that attempt. Crash recovery identifies and
cleans owned orphan temporary files; it does not restore download tasks or claim
interrupted-download resume. Disk exhaustion, failed publication and cleanup
errors remain visible results.

Remote print preparation depends on the isolated runtime parser and agent
normalization, then on the existing device/material validation and job-start
execution. Keep a disposable inspection context independent of the user's project;
bound archive expansion, metadata sizes and Worker lifetime. The adapter maps
opaque print-target identities to device plate numbering. Submit one target,
revalidate current device/material conditions and reuse explicit warning
acknowledgements; a submitted command is not proof that the physical print has
completed. Do not auto-retry an uncertain print start.

Stored-media delivery depends on qualified file reads and the host media binding.
Use bounded disk cache and a bounded player buffer; cleanup revokes access and
releases reads as well as deleting owned cache. Cache exhaustion is a visible
playback failure with the explicit download alternative, not permission for
unlimited memory buffering. Establish supported formats through actual demuxing/
decoding and seek tests. Keep format qualification separate from Bambu protocol
read support, and do not silently count external-player fallback as proof that
first-delivery in-app progressive playback works.

The browser implementation later binds the same semantic contracts to browser
networking, Worker execution and save/media capabilities. It must not require
Electron main, load native Bambu libraries into a browser, or treat a gateway's
filesystem as the user's save destination. No gateway delivery, plugin upgrade
or change to the current project's mutable runtime is authorized by this design.

#### Initial qualification boundary

Development-host software acceptance now covers workspace tests/typechecks,
both wasm64 quick builds, comprehensive serial bridge smoke, and threaded remote
inspection through the real parser and the built disposable Node Worker. Electron
fixtures cover Storage browsing/actions, same-device authorization recovery,
local/remote print preparation, generated AVC decoding/seeking and utility cache
cleanup, camera regression and project/window-close behavior. Desktop renderer CSS
and the Web frontend build pass. Existing skipped tests remain skipped; this is
not the dual-host/dual-WASM release matrix or packaged-platform qualification.
The Web host still reports Bambu managed Storage operations unavailable.

The 2026-11-03 read-only H2D + AMS acceptance used macOS 15.7.7 arm64,
Electron 43.4.0, the pinned networking plugin v2.2.0 (series 02.08.01), printer
firmware 01.04.00.00 and AMS firmware 01.00.07.00. No remote deletion, print
submission or material operation was executed. The production desktop build
and real LAN transport established the following narrower results:

- USB browsing returned 35 print files, 25 timelapses and 88 recordings.
  Visible samples decoded real 512-by-512 print thumbnails and 480-by-480
  timelapse/recording thumbnails; this does not assert every file has a preview.
- Discovery IDs and list selectors differ on this firmware: advertised `udisk`
  returns error 17 when sent literally to `LIST_INFO`. The adapter now follows
  Orca: omit the selector for external `udisk`/`sdcard`, and translate `emmc`
  to `internal`. Preserve the discovered ID in domain references. The advertised
  internal device still returned error 17 with `internal`; internal browsing
  remains unqualified, and the UI presents it as Internal storage.
- Three existing 3MF files (including Chinese names) and three MP4 files saved
  successfully through the host task path and native terminal length/MD5 checks.
  All three 3MF ZIP CRC checks passed. The largest recording was 251,759,820
  bytes; its local streaming write lasted approximately 42 seconds. Cancelling
  a second transfer at about 74 MiB eventually reached `cancelled`, removed its
  partial file and preserved the completed original. Native teardown kept the
  task in `Finishing` temporarily; cancellation latency was not precisely measured.
- Two real video opens correctly offered the explicit download fallback. All
  three downloaded videos contained AVC `avc1.64c028` at 1680-by-1080 with
  `moov` after `mdat`, outside the selected fast-start progressive subset.
  Downloads opened through the app in QuickTime: the timelapse decoded to its
  3.459-second end, and the 258.876-second recording sought to 120 seconds and
  continued playing. **This establishes system-player fallback, not real H2D
  embedded progressive playback or cached-range seeking.** Closing the failed
  viewers left no video resource cache. No format conversion or silent full-file
  buffering was added to make the acceptance pass.

A read-only recheck of the capability-gated build on the same H2D returned the
same 35/25/88 external collection counts. No Internal selector was exposed for
print files, timelapses or recordings in that session. This verifies conservative
visibility and the External default; internal listing and a real capability change
remain unqualified. Remote deletion, print submission and material operations were
not performed.

Sparse normal-speed process measurements do not establish a plugin-to-host
memory bound. Slow consumers, stopped progress, fault injection, mixed playback
admission, immediate native cancellation and other storage/host variants remain
unqualified. The real tail-index video format is a concrete remaining gap for
the first-delivery embedded-player requirement; expanding that format boundary
requires a separately agreed design.

H2D + AMS is the first delivery's physical acceptance target. Cover the storage
and media capabilities it actually exposes, including SD/internal storage where
supported, file management, a physical device-file print with plate/material
preparation, qualified progressive playback and seeking/fallback behavior, large
downloads, and cancellation/failure cleanup. Capability-based availability on
other Bambu models does not establish that those models were physically tested;
report the distinction explicitly.

Qualification includes long transfers beyond the current small-resource deadline,
slow consumers, stopped progress, queue cancellation, disk/publication errors and
memory behavior across the plugin/native/host chain. Mocks or IPC backpressure
alone do not qualify the pinned plugin's internal buffering. Record actual device,
firmware, plugin and host platform for results. Physical acceptance remains open
and is required before claiming a qualified complete first delivery. Software
implementation and fixtures do not establish real-printer file management,
printing, video compatibility or end-to-end native buffering behavior. Exact
physical cases and resource thresholds remain to be specified, without requiring
all Bambu model families for first acceptance.
Use the [testing guidelines](../doc/testing_guidelines.md) for the affected-package,
host and WASM verification scope; passing fixtures cannot replace these physical
and native-resource qualification gates.

## 10. Data, credentials and host contracts

Domain snapshots and metadata are serializable values. Local SDK objects such
as service methods, asynchronous streams, cancellation signals and binary
chunks are not JSON DTOs; future IPC/network bindings must define their
transport and lifetime explicitly. Do not commit to a gateway protocol merely
because a local interface uses a particular language construct.

Use opaque, scoped resource identities and validate references, variants, units,
ranges, color forms and non-empty mutations at boundaries. Unknown data is
explicit; unsafe casts and unvalidated vendor payloads are not normalization.

The proposed domain exposes credential references, with secrets resolved by the
owning host/provider. Temporary media authorization must not enter persistent
device snapshots or logs. This is a target boundary, not a claim that the
existing saved Moonraker API-key representation has already changed. Its
migration and host credential-store behavior require a separate implementation
decision that preserves authorized existing use.

Mobile product support remains deferred under the shared architecture. The
domain does not depend on hover, mouse-only input or desktop globals; eventual
mobile UI and playback require separate qualification. Multiple video streams,
large G-code parsing and transfers can be expensive: use bounded streaming,
managed viewing lifetimes and work off the UI thread where needed. No automatic
multi-camera playback or unlimited in-memory file buffering is implied.

## 11. Modeling and acceptance boundaries

Use these examples to assess the proposed initial model without vendor-specific
shared types or fabricated capabilities. They preserve the requested modeling
coverage without prescribing the final record layout:

| Device shape | Required representation |
| --- | --- |
| Single-extruder printer with an external spool | One manual material path; no automatic feeder requirement. |
| Single-nozzle printer with multiple automatic feeders | Independent units and slots routed to a tool; no fixed four-slot grouping. |
| Multi-tool or multi-nozzle printer | Distinct tools, extruders and nozzles, with multiple active tools representable. |
| Enclosed printer with passive chamber probe and door switch | Read-only temperature and door sensors; no invented chamber heater. |
| Actively heated chamber | Heater target/control plus a referenced temperature reading when reported. |
| Material dryer with humidity and temperature monitoring | Dryer operational state plus shared sensor references, without duplicate readings. |
| Printer with live video and stored timelapses/G-code | Separate live and remote-file resources sharing managed media delivery. |
| Partially observable or offline printer | Partial topology and unknown/stale observations without falsely declaring support or readiness. |

Required request-based acceptance scenarios include local saving of an unreachable
printer, zero printer requests during startup/enumeration/local description,
Moonraker selection opening its configured Web page without agent traffic,
upload without listing or connection, and U1 material reads only on explicit
sync. Failed sync retains prior data without background retries. Test independent
calls through a fresh service reference, scoped media/operation references,
optional comparison versions, and unsupported watch on on-demand-only topics.
Print-status runtime coverage must include externally started prints, missing
history, terminal phases, idle resets, independently unknown fields, stale cache
reads and failed refreshes. Ordinary controls must execute through a fresh service
facade without status/history/evaluate calls, while preserving request deduplication
and device acknowledgements. No observation or control starts implicit polling.
Special-action type fixtures must cover status/alert sources, opaque references,
configuration provenance and independent submission, and reject raw job selectors
or vendor parameter bags. Future supporting agents must additionally test altered,
wrong-target, expired and stale references, closed observers, context changes and
repeated requests without retargeting or duplicate execution. Moonraker tests only
its unsupported special-action boundary; these fixtures do not qualify a future
vendor action executor.
Capability fixtures must reject null descriptions and empty required choices,
while allowing unknown individual limits and meaningful optional empty lists.
A supported Moonraker upload must be constructible from its declared default
destination, formats and collision policies without a capability probe.
Discovery fixtures must construct requests from host-specific capability
descriptions, reject supported discovery without a host identity or scope
choice, and retain providers with no hosts or manual-only hosts without
fabricating discovery support. Different hosts may support different scopes.
Material import fixtures must retain configuration provenance from the source
inventory snapshot and reject proposals with missing or null configuration
revisions. Future application integration must reject a proposal after a route
configuration change, including when topology/inventory tokens are unchanged,
without project mutation or automatic device access.
Preview fixtures must construct an option query and media-open request when
preview is supported but stat is unsupported, including empty options and
file/device/configuration provenance. Future adapters must validate access and
option support without relying on a prior query session. Storage removes the
earlier file-content version preconditions; corresponding fixtures must migrate
with that contract while retaining rejection of stale device/configuration context.
Observation fixtures must cover single-topic access, widened/dynamic selections,
explicit union type arguments, and both subscription snapshots and replacements.
They must reject unchecked access to possibly absent topics and empty payloads.
Future adapters must verify that complete snapshots include every actual
requested topic and no unrelated topics, even when some readings are unknown.
Sensor fixtures must cover sensor-only reads without descriptor support, typed
passive probes and generic/extended sensor values, and replacement events that
carry both definitions and readings. Future adapters must also verify ID/kind
consistency and definition-version changes without extra device discovery.
These are future runtime acceptance requirements; compile-only fixtures validate
interface expressibility, not network behavior.

Future implementation acceptance should cover stale feed cursors and resource references,
coherent resynchronization, stale control context, unknown command outcomes, independent
sensor/actuator support, material/project isolation, media teardown, changed-file
races, unsupported operations and upload-success/start-failure recovery.
Mock/type validation does not qualify physical-printer behavior, cloud account
permissions, browser networking or media interoperability. Select execution
scope using the [testing guidelines](../doc/testing_guidelines.md).

In addition to the reviewable mechanisms in section 1.1, open decisions include
exact model support and providers beyond the selected Bambu design; discovery
details and the separately owned account authentication mechanisms; gateway deployment,
wire protocol and cross-version negotiation; credential migration; operation
retention and deduplication guarantees; media proxy/transcoding feasibility;
and the runtime/parser context for remote toolpath previews. Resolve these
against the constraints above before claiming the corresponding capability.
The existing Moonraker subset in section 1.3 is delivered with runtime and
host-integration tests. Other agents, the gateway, rich device UI and runtime
validation for unimplemented capabilities remain outside the delivered scope.
