# Printer Domain and Control Architecture

**Updated:** 2026-10-21

**Status:** Explicit requirements and selected architecture direction recorded;
initial TypeScript domain contracts are available. Concrete agents, gateway,
runtime validation and application integration remain deferred. Interface
availability does not establish device support or runtime delivery.

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
| Manually add printer type and IP/address, and persist locally | Saving, startup, enumeration and local description must not connect, probe or discover device capabilities. |
| Preserve request-driven Moonraker use | Selecting the printer can immediately open its configured native Web interface; uploads execute on demand without ongoing observation. |
| Support manually triggered material synchronization on specific Klipper types, such as Snapmaker U1 | Declare this type-specific capability locally; read inventory only on explicit sync, with no startup fetch or background polling. |
| Include basic printer controls and AMS-like controls | Model ordinary printers and automatic material systems without making one manufacturer's AMS layout universal. |
| Synchronize printer information and consumables | Observe device state and material inventory, with an explicit boundary around project changes. |
| Include cameras | Model live viewing and camera-related capabilities, not just a stored camera URL. |
| Offer an optional native Web interface | Describe support independently of Neo control support, and resolve its entry without requiring a control session. |
| Derive Monitor, file browser, warnings and Firmware visibility from available functions | Keep page eligibility in the application, separate from current availability and content counts. |
| Firmware information can be read without upgrade support | Keep version observations distinct from future update checking or installation. |
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
| Remote-file consistency | Explicit strict/best-effort version modes and route-scoped references; provider support and the exact request model need validation. |
| Transfers | Paged listings, streamed reads, invalidation notifications and reject/rename upload policies; no exact wire API or universal provider support is assumed. |
| Credentials | Opaque credential references; migration and host storage require a separate decision. |
| Project material import | A revision-bound proposal followed by an explicit native transaction; the precise review UI and proposal representation remain open. |

A proposed abstraction is not evidence that a particular printer or host
already implements it. This classification applies to sections 2–11, including
their suggested acceptance scenarios. Including a feature in the domain does
not require every printer or provider to support it; capability reporting must
preserve that distinction.

### 1.2 Current interface boundary

The type-only [domain entrypoint](../packages/printer-control/src/domain/index.ts)
is exported as `@orca/printer-control/domain`. It defines the initial concrete
contract for printer resources, materials, extensible sensors, controls,
capabilities, files, media, discovery, manual configuration and native Web entry
resolution. All public operations are independently addressed. Discovery and
saved-route enumeration use the same capability model as local description;
type-known support does not require a probe. Observations explicitly distinguish
cached access from a one-shot device read, including materials and firmware.
The source is authoritative
for current field shapes; this specification records their purpose and limits.
The [compile-only consumers](../packages/printer-control/typechecks/domain.ts)
exercise public imports, typed extensions, command/result correlations and
representative printer shapes without implementing an agent.

The interface selects typed topic reads, replacement events with opaque cursors,
a typed command map, explicit media resource references and file consistency
modes from the proposals above. Those are current contract choices,
not evidence that the user mandated a particular transport or permanent schema.
Future refinements update the single contract and its consumers together.
No gateway wire format, persistence migration or protocol executor is defined.

The existing package root continues to expose the operational Moonraker HTTP
driver and Send service. That host-injected HTTP seam does not implement the new
domain service. This interface-only step adds no compatibility adapter or
alternative runtime payload format; integrating a provider and switching its
application callers is separate work. Project material import remains an
application-owned workflow; its proposal type does not authorize telemetry to
mutate a native project.

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
route must not probe, authenticate against or read from the printer. Startup
must not automatically discover capabilities or establish subscriptions for
request-based printers. Selecting Moonraker opens its configured Web interface
without an agent connection or preflight. Loading that page has its own network
traffic; it does not imply agent-owned control or inventory requests.

Discovery is an explicit optional operation scoped to an execution host and
source such as LAN or an account. Candidates can expire; adoption is a separate
configuration operation with self-contained candidate data, validated by the
provider rather than trusted as executable authority. Discovery is never a
prerequisite for manual addition. Saved entries remain visible when unreachable.
Adding or discovering a printer does not select it as a print target. Preserve
the independent console and send selections in the console specification.
Forgetting removes Neo configuration, not remote files, account bindings or jobs.

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
formats, observation delivery modes and discovery scope kinds. Optional feature
collections can be empty only with defined behavior: an empty camera profile
list means omit profile selection and let the adapter choose delivery; an empty
job-timelapse list means no optional job-level timelapse choices. Neither is an
unknown required-choice placeholder. Pause/resume/cancel have an explicit empty
constraint object because their job target comes from the request, with no
additional selectable parameters.

Only specific documented limit fields may be null: upload size, concurrent
viewer count, and individual numeric-range bounds/granularity can be unknown.
Keep their containing descriptors and resource IDs present. Null does not mean
unlimited, safe, zero or a provider-selected numeric default. Callers can check
known bounds, but must not invent slider bounds or step values for unknown ones.
Intrinsic parameter semantics still apply, such as finite numbers, appropriate
units and fraction bounds. Unrelated optional metadata keeps its own documented
absence semantics; this rule does not redefine all null values in the domain.

A capability supplies the operation description, not user content or live
selection: the caller still supplies its file, selected job and parameter values.
Do not place a current job or per-file inventory into capabilities to duplicate
observations. Execution validates requests regardless of prior description or
client checks. Failure to read a new limit does not erase a still-valid earlier
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

The [Web interface contract](../packages/printer-control/src/domain/web-interface.ts)
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
tab order or default selection. Use one application policy when UI integration
is implemented; the current change defines that policy without implementing it.
Locally established capabilities are sufficient for eligibility; no connected
snapshot is required. Eligibility does not authorize automatic device reads.
In particular, selecting a request-based printer must not start capability
probes or material synchronization. Unknown individual limits can be explained
locally or checked during the requested operation, without forcing a universal
connecting screen. A configured Moonraker Web entry opens normally.

| Page | Eligibility | Conditions that do not remove eligibility |
| --- | --- | --- |
| Monitor | At least one supported observation suitable for monitoring (job, thermal, motion, actuators, materials or sensors), camera viewing/snapshot capture, or basic control. A standalone material-import action is insufficient. | No active job, no camera, a temporarily unavailable camera, or readings not yet reported. |
| File browser | File listing is supported for at least one storage scope. | An empty directory, temporarily missing removable storage, or unavailable download/delete actions. |
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
selection behavior is preserved. No UI policy helper or page is implemented yet.

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

Synchronized information includes printer operational state, active tools, current job identity/source and phase,
progress and remaining-time estimates, actuator and motion state, material
inventory, camera state, sensor readings and alerts. Job absence is distinct
from unknown job state. Alerts retain identity, severity and a usable message;
warnings and estimated values must not be promoted to confirmed device facts.

Reads explicitly select cache or device access and the requested topics. Device
access performs only the requested one-shot read; it does not require a full
snapshot, prior evaluation or a persistent connection. Unknown and stale values
remain explicit, including failures in part of a multi-topic read. Transport
and authentication errors belong to the request/resource, not a global state
that gates all other APIs.

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
Job actions target a job identity, not an assumed current list entry. Specialized
calibration or coordinated printer modes require additional semantic design.

Distinguish submission rejection, recorded acceptance and an unknown submission
outcome. An accepted command is not necessarily acknowledged by the device;
acknowledgment is not physical completion. Completion needs a device result or
an appropriate observed-state confirmation. Transport loss after dispatch can
leave the outcome unknown and must not be relabeled as safe failure.

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
timelapse is a remote file, optionally linked to a known job; it is not a live
camera resource. Watching a camera must not implicitly enable recording.

## 9. Remote files, previews and transfers

Model storage, directories, remote files and file content identity explicitly.
Files include uploaded printable artifacts, timelapses, recordings, images and
unrecognized content. Metadata describes name, format/media type, size and
timestamps when known, with type-specific information such as printable
material keys, duration, dimensions and associated job. Storage availability
and capacity/free space are independent of file metadata and may be unknown.
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
result carries the assessed file identity/version and available options; an
empty option list means the file has no preview, while query failures remain
explicit errors. Opening uses that file selection and option identity, with
client media negotiation, and revalidates them at execution time. Option IDs
are scoped to the file/configuration/content, not a prior query session; a
fresh service reference can use them without hidden caller state. Strict and
best-effort consistency rules apply to both option queries and media opening.

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

Upload can address an adapter-defined default destination from local type/configuration,
without first listing storage or directories. Explicit directory selection
remains available where supported. Upload-only adapters need not implement file
browsing. No connection or unrelated device preflight is required.

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

Required request-based acceptance scenarios include local saving of an unreachable
printer, zero printer requests during startup/enumeration/local description,
Moonraker selection opening its configured Web page without agent traffic,
upload without listing or connection, and U1 material reads only on explicit
sync. Failed sync retains prior data without background retries. Test independent
calls through a fresh service reference, scoped media/operation references,
optional comparison versions, and unsupported watch on on-demand-only topics.
Capability fixtures must reject null descriptions and empty required choices,
while allowing unknown individual limits and meaningful optional empty lists.
A supported Moonraker upload must be constructible from its declared default
destination, formats and collision policies without a capability probe.
Preview fixtures must construct an option query and media-open request when
preview is supported but stat is unsupported, including empty options and
file/version provenance. Future adapters must validate stale options and file
changes without relying on a prior query session.
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
provider prioritization and exact model support; discovery and account
authentication mechanisms; gateway deployment,
wire protocol and cross-version negotiation; credential migration; operation
retention and deduplication guarantees; media proxy/transcoding feasibility;
and the runtime/parser context for remote toolpath previews. Resolve these
against the constraints above before claiming the corresponding capability.
Concrete agents, gateway, runtime validation and UI integration remain outside
the delivered interface boundary.
