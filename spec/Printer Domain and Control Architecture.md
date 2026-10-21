# Printer Domain and Control Architecture

**Updated:** 2026-10-21

**Status:** Explicit requirements and selected architecture direction recorded;
detailed design remains a proposal for review. Concrete agents, gateway and
domain implementation are deferred. This document does not claim delivery.

**Scope:** The shared printer domain: discovery, identity, hardware properties,
capabilities, controls, material systems, read-only sensors, cameras, remote
files and synchronization across Web, Electron and future connection services.

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
| Abstract the various printer control interfaces | Shared features use a vendor-independent domain boundary. |
| Provide available-printer listing and discovery | Saved printers, discovery candidates and currently reachable routes are distinguishable. |
| Include basic printer controls and AMS-like controls | Model ordinary printers and automatic material systems without making one manufacturer's AMS layout universal. |
| Synchronize printer information and consumables | Observe device state and material inventory, with an explicit boundary around project changes. |
| Include cameras | Model live viewing and camera-related capabilities, not just a stored camera URL. |
| Preview remote files, including timelapses and uploaded G-code | Treat stored media and printable files as first-class resources with appropriate preview types. |
| Download, delete and reprint remote files | Define independent operations and their availability; reprinting starts an existing remote printable file. |
| Support temperature probes without temperature control, plus other sensors such as door switches | Provide a generic read-only sensor collection with data that varies and can expand by sensor type. |
| Integrate the design and check duplicates, omissions and responsibility boundaries | Maintain one coherent domain model and retain examples for different printer configurations. |
| Defer concrete agents and the gateway | Recording this specification does not authorize their implementation. |
| Record constraints rather than concrete TypeScript interfaces | Keep interface source code and exhaustive API signatures out of this specification. |

The nozzle-material question was answered by distinguishing nozzle construction
material from loaded filament. Preserve that distinction in the design; the
suggested property name is not an independently approved interface requirement.
The requested modeling examples are retained in section 11. Neither those
examples nor the feature lists below are an exhaustive ceiling on printer
support: the original functional request was explicitly non-exhaustive.

### 1.1 Decision status and interpretation

The explicit requests above and selection of option B are established user
decisions. Existing requirements inherited from linked repository specifications
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
| Synchronization | Initial snapshots, whole-section replacements, connection epochs and separate revisions; equivalent coherent synchronization is possible. |
| Operation tracking | Service-scoped tracking and request lookup; ownership, storage and retention are not prescribed. |
| Sensor representation | Typed readings, common sensor storage and references from heaters/material units; extension registration and lookup/indexing are open. |
| Media | One media-session abstraction for live and stored content, and WebRTC signaling when selected; concrete transports and session reuse rules are open. |
| Remote-file consistency | Explicit strict/best-effort version modes and route-scoped references; provider support and the exact request model need validation. |
| Transfers | Paged listings, streamed reads, invalidation notifications and reject/rename upload policies; no exact wire API or universal provider support is assumed. |
| Credentials | Opaque credential references; migration and host storage require a separate decision. |
| Project material import | A revision-bound proposal followed by an explicit native transaction; the precise review UI and proposal representation remain open. |

A proposed abstraction is not evidence that a particular printer or host
already implements it. This classification applies to sections 2–11, including
their suggested acceptance scenarios. Including a feature in the domain does
not require every printer or provider to support it; capability reporting must
preserve that distinction.

The [shared application architecture](Web-Electron%20Shared%20Application%20Architecture.md)
remains the application-wide authority. [Printer Console and Control Integration](Printer%20Console%20and%20Control%20Integration.md)
owns existing console and Send/Send & Print interaction. This document owns the
future domain beneath those and richer device features, without changing their
existing selection, cancellation or retry behavior. [Multi-Filament Support](Multi-Filament%20Support.md)
owns the project's native material rack. [Grand Plan](Grand%20Plan.md) remains
the only delivery roadmap; recording this design changes no delivery status.

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

## 3. Identity, discovery and connection lifecycle

Separate the physical/logical printer identity from its connection routes,
provider, execution host and active session. One printer may have several
routes. A display name, network address or list position is not a stable device
identity and is insufficient by itself to merge discoveries.

Discovery is scoped to the executing host and source, such as LAN discovery,
an account's devices or a manually supplied address. Candidates are provisional
and can expire; adopting one into saved configuration is a separate action.
Saved entries remain visible when offline. Lack of discovery support does not
imply that manual connection is unsupported.

Adding or discovering a printer does not select it as a print target. Preserve
the independent, explicit console and send selections in the console spec.
Forgetting a saved printer removes Neo configuration; it does not unbind a
cloud account, delete remote files or cancel a physical print.

In the proposed model, a logical session survives reconnection while an epoch identifies
each connection incarnation. The semantic goal is to reject obsolete events
and command context, and revalidate dependent resources after reconnection;
the particular epoch and session-identity scheme remains open. Shared managed
subscriptions are proposed to avoid independent polling by every widget;
their ownership and caching mechanism are not fixed here.
Closing a view or session releases its subscriptions and media resources;
it does not implicitly stop a printer job.

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

Track selected and loaded paths independently, with loading, unloading,
switching and fault state. The selected next source is not necessarily the
material already loaded. Represent manual action or missing reporting honestly.
Loading, unloading, switching, writable metadata, tag refresh and drying are
independent capabilities with resource-specific constraints. Observation
support does not imply permission to modify material metadata.

Inventory synchronization updates the device model. It must not silently
rewrite the open project's native rack, presets, colors or assignments.
Import into the project is an explicit application workflow. The proposed flow
prepares a mapping with enough device/project context to detect stale input and
exposes empty slots, missing data and unresolved preset matches. The exact
proposal fields and confirmation UI remain open. Applying it follows existing
native compatibility rules and the atomic history contract. A failed or stale
proposal cannot partially change the project.

Project slot identity and physical device slot identity stay separate. Print
submission binds the printable artifact's material keys to actual material
paths, subject to the route's mapping capability. Do not derive this binding
from coincident array positions or assume that importing device inventory is
required before every print. The existing native rack, preference and
Undo/Redo contracts remain owned by the multi-filament specification.

## 7. State synchronization and command outcomes

Synchronized information includes connection/authentication state, printer
operational state, active tools, current job identity/source and phase,
progress and remaining-time estimates, actuator and motion state, material
inventory, camera state, sensor readings and alerts. Job absence is distinct
from unknown job state. Alerts retain identity, severity and a usable message;
warnings and estimated values must not be promoted to confirmed device facts.

The proposed event model starts with a complete snapshot, then publishes
ordered replacements of complete sections, with a fresh snapshot after a
connection epoch changes. This is a candidate synchronization strategy, not a
requirement to replace whole sections or prohibit normalized deltas. Any chosen
strategy needs coherent topology/state publication, obsolete-event rejection
and recovery from missed updates, expired subscriptions and invalid references.
Arbitrary vendor payloads cannot themselves serve as the shared domain model.

Descriptor, topology, capability and inventory revisions have distinct
meanings in the proposed sketch. Their exact tokens and grouping are open;
control validation needs enough current context for the command's correctness,
without requiring every command to carry every revision. Sensor
telemetry changes alone must not invalidate an unrelated material mapping.
Observations may be pushed, polled or obtained on demand, with support declared
per topic, including sensors. Refresh does not promise that every reading
becomes known or fresh.

Basic controls include job start/pause/resume/cancel, temperature targets,
fans, lights, homing, jogging, extrusion and tool selection where supported.
Material and camera controls use the same typed command/outcome discipline.
Job actions target a job identity, not an assumed current list entry. Specialized
calibration or coordinated printer modes require additional semantic design.

Distinguish submission rejection, recorded acceptance and an unknown submission
outcome. An accepted command is not necessarily acknowledged by the device;
acknowledgment is not physical completion. Completion needs a device result or
an appropriate observed-state confirmation. Transport loss after dispatch can
leave the outcome unknown and must not be relabeled as safe failure.

Preserve a way to reconcile submitted work after a view or session closes.
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

## 8. Cameras and media sessions

Describe cameras as hardware resources, optionally associated with a tool or
light. Expose their availability and observed state separately from supported
live-view formats, snapshots, enable/disable controls and timelapse modes.
Do not infer camera controls from the mere presence of a stream.

The current proposal shares a managed media-session boundary between live
camera viewing and stored-file presentation. This reuse is not required if
separate abstractions better preserve consistent availability, authorization,
playback and cleanup semantics. Select delivery against client transport and
format/codec support.
The domain can describe browser-consumable HTTP video, HLS, MJPEG or WebRTC
without requiring every provider to implement all of them. Protocol-specific
camera addresses and private transport credentials remain agent concerns;
a source URL is not evidence of browser playback capability.

The proposed media session manages temporary delivery information,
expiry/renewal where applicable, state, errors and explicit closure. Advertise
available profiles, resolution/frame rate and playback properties such as
duration and seekability when known; these are not guaranteed for every stream.
If WebRTC is selected, its signaling must handle offer/answer and ICE without
losing initial signals. Negotiation identities and descriptor revisions are
candidate mechanisms. Parent closure or reconnection requires cleanup or
explicit resource revalidation; mandatory destruction and recreation of every
media session is not settled. Respect applicable concurrent-view limits and
release resources when viewing ends.

Snapshot capture is independent of live viewing. Device-level timelapse
configuration is separate from a print job's timelapse options. A recorded
timelapse is a remote file, optionally linked to a known job; it is not a live
camera session. Watching a camera must not implicitly enable recording.

## 9. Remote files, previews and transfers

Model storage, directories, remote files and file content identity explicitly.
Files include uploaded printable artifacts, timelapses, recordings, images and
unrecognized content. Metadata describes name, format/media type, size and
timestamps when known, with type-specific information such as printable
material keys, duration, dimensions and associated job. Storage availability
and capacity/free space are independent of file metadata and may be unknown.
The proposed remote reference is scoped to printer, route and storage. A
filename or host-private filesystem path alone is not a portable identity.
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

Download, delete, preview and print are independent operations. Only supported
printable artifacts can be started; timelapse playback does not confer print
eligibility. Reprint uses the same start-job semantics as starting a newly
uploaded file, with current material bindings, job options and preconditions.
Do not introduce a parallel reprint command with weaker checks.

The current proposal gives version-sensitive requests explicit strict and
best-effort modes. Whether every operation exposes these modes and how an
adapter establishes content identity remain open. If strict matching is
offered, it requires a known content revision and an adapter that can enforce
the check atomically with the operation; otherwise reject it.
Never silently downgrade strict matching. Best effort still rejects a known
revision mismatch, while honestly retaining any race that the device protocol
cannot eliminate. Whatever request model is selected, communicate its actual
consistency guarantee for reads, previews, deletion and print start; a provider
without atomic version checks is not thereby excluded from all file operations.

Uploads report transfer progress separately from device confirmation and return
the actual remote artifact identity. Upload completion does not imply print
start. If start fails after upload, retain the artifact and allow a start-only
retry as required by the console spec. Collision handling is explicit; rejection
or rename were the proposed initial policies. Whether explicit overwrite is
supported remains open; it must not be introduced as a silent default.
Cancellation or an uncertain outcome must not claim that remote data was cleaned up.

Large transfers need bounded resource use. Streaming with backpressure is the
proposed mechanism; exact chunk transport and small-payload handling are open.
Report actual ranges and byte counts; unsupported range requests must not masquerade
as successful partial responses. Temporary preview URLs/content handles have
managed lifetimes rather than permanent configuration ownership.

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

Future implementation acceptance should cover obsolete-connection events,
coherent resynchronization, stale control context, unknown command outcomes, independent
sensor/actuator support, material/project isolation, media teardown, changed-file
races, unsupported operations and upload-success/start-failure recovery.
Mock/type validation does not qualify physical-printer behavior, cloud account
permissions, browser networking or media interoperability. Select execution
scope using the [testing guidelines](../doc/testing_guidelines.md).

In addition to the reviewable mechanisms in section 1.1, open decisions include
provider prioritization and exact model support; discovery and account
authentication mechanisms; gateway deployment,
wire protocol and cross-version negotiation; credential migration; operation
retention and deduplication guarantees; media proxy/transcoding feasibility;
and the runtime/parser context for remote toolpath previews. Resolve these
against the constraints above before claiming the corresponding capability.
Concrete interface source, agents, gateway and UI implementation remain outside
this documentation change.
