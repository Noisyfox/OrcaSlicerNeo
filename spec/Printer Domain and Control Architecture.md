# Printer Domain and Control Architecture

**Updated:** 2026-10-23

**Status:** Explicit requirements and selected architecture direction recorded;
TypeScript domain contracts and the existing Moonraker subset are implemented.
Device Web entry and Send use the stateless service in both hosts. Electron
Bambu integration follows section 2.1; section 2.2 distinguishes delivered
foundations, account flow, Cloud device enumeration and LAN access. LAN
real-device qualification is deferred and does not block packaging work.
Section 2.3 records the accepted Bambu monitoring/control scope and interactions,
with implementation authorized in independently verified increments and physical
qualification deferred until software verification is complete. The gateway remains deferred.
Interface availability alone does not establish device support or runtime delivery.

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
| Remote-file consistency | Explicit strict/best-effort version modes and route-scoped references; provider support and the exact request model need validation. |
| Transfers | Paged listings, streamed reads, invalidation notifications and reject/rename/overwrite upload policies; no exact wire API or universal provider support is assumed. |
| Credentials | Opaque credential references; Bambu session storage/refresh is delegated to the black-box plugin in section 2.1. Other credential migration and host storage remain open. |
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
No gateway wire format or credential persistence migration is defined. The bounded
Moonraker runtime migration is described below.

The package root exports the [Moonraker service factory](../packages/printer-control/src/service.ts).
It implements the domain service using host-injected configuration and HTTP
transport. Both hosts provide this service through the platform contract;
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
errors. Existing settings still edit the host configuration repository and
Electron retains its existing built-in console authentication script. This is
not a credential-storage migration. Route changes invalidate cached readings
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
reference. File version comparison is unavailable, so start uses explicit
best-effort consistency. No listing or connection preflight is required.

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

The [printer contracts](../packages/printer-control/src/domain/service.ts) now
use provider-owned account association, route-targeted rename/forget operations,
local management permissions, access-code authorization and saved-list change
notifications. [Route configuration](../packages/printer-control/src/domain/printer.ts)
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
the `02.08.01` library series supported by the checked-in Orca declarations. All six
archives have been downloaded, SHA-256 verified and staged. The macOS ARM64
plugin reports `02.08.01.99` through the addon in both Node and Electron's Node
runtime. The six-platform packaged checks in step 8 verify the same plugin
version during ordinary startup.

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
The Home entry and immediate provider settings use only the common account
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
access input and provides verification of saved access. It does not select a
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

**Decision status:** Shared control cards with Bambu-specific composition and
advanced controls are selected, with H2D + AMS as the first physical acceptance
target. Implementation is authorized in independently tested and committed
increments; physical qualification is performed last. The
[console specification](Printer%20Console%20and%20Control%20Integration.md#bambu-control-design)
owns the feature envelope, presentation and grouped interaction decisions,
including the exclusions of video, file browsing and an HMS tab.

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

The current
[renderer provider](../apps/desktop/src/renderer/src/platform/bambuProvider.ts)
advertises discovery-only support. The
[native boundary](../packages/bambu-native/src/index.ts) already exposes message
callbacks and LAN sending, but control requires additional exported plugin calls
and an explicit observation/operation IPC binding. Follow the checked-in Orca
callers and declarations for Cloud sending, subscriptions and any specialized
material operations; do not assume LAN sending covers Cloud control. Public IPC
must validate typed requests and return normalized data without vendor payloads
or credentials.

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

For Bambu control, a present Cloud route takes precedence over an authorized LAN
route. There is no manual route switch and no automatic LAN fallback after
Cloud failure. A successful catalogue change that removes Cloud may select a
retained LAN route; already-dispatched commands remain bound to their original
route and are not replayed. No route union or transient read failure may invent
capabilities or change this policy.

UI observation lifetime, provider connection lifetime and operation lifetime are
separate. Stopping a view subscription does not cancel a physical operation.
Bambu observation starts automatically when the selected printer's control view
is shown. Leaving that view pauses hidden UI updates while the provider retains
the connection, receives status and updates its cache. Outstanding operations
continue to be tracked. The console specification owns these accepted behaviors
and restoration of the last selected Device printer across all providers.
Restoring a Moonraker selection does not authorize background observation.

#### Contract extension boundaries

The current typed contract includes `jobs.setSpeed` with discoverable mode IDs
and labels, and `hardware.refreshNozzles` for explicit device re-identification.
Nozzle records include nullable type and flow type alongside material and diameter.
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
RFID re-read, drying-control or AMS behavior-settings executors for this delivery.
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
operation lookup independently of the view. Command-specific evidence, retention
and deduplication windows, freshness thresholds and confirmation timeouts require
protocol evidence and validation during implementation. The selected UI follows
Orca's corresponding control states, local messages and necessary dialogs; it
does not add a unified operation-history panel or uniformly persistent outcome
badges. This does not weaken underlying outcome tracking or replay restrictions.
Relevant device errors and supported contextual recovery actions remain included
in the control cards; an independent HMS page remains excluded.

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
Physical H2D + AMS evidence must establish the operations and Cloud/LAN routes actually
claimed. Qualify Cloud first, then LAN, with separate evidence for each path.
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
tab order or default selection. The Device UI applies one application policy for
its Web Interface and Monitor tabs; other pages remain future work.
Locally established capabilities are sufficient for eligibility; no connected
snapshot is required. Eligibility does not authorize automatic device reads.
In particular, selecting a request-based printer must not start capability
probes or material synchronization. Unknown individual limits can be explained
locally or checked during the requested operation, without forcing a universal
connecting screen. A configured Moonraker Web entry opens normally.

| Page | Eligibility | Conditions that do not remove eligibility |
| --- | --- | --- |
| Monitor | At least one supported observation suitable for monitoring (status, thermal, motion, actuators, materials or sensors), camera viewing/snapshot capture, or basic control. A standalone material-import action is insufficient. | No active job, no camera, a temporarily unavailable camera, or readings not yet reported. |
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
selection behavior is preserved. The initial Monitor exposes status, sensors,
heater targets and basic print controls; camera viewing and other monitor cards
remain future work.

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
exposes empty slots, missing data and unresolved preset matches. Beyond the
required provenance below, proposal details and confirmation UI remain open. Applying it follows existing
native compatibility rules and the atomic history contract. A failed or stale
proposal cannot partially change the project.

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
retry after a definite failure as required by the console spec. Collision
handling explicitly supports reject, rename and overwrite. Each destination
advertises the policies it implements; callers must select one of them.
Overwrite is a normal capability, not an alias for reject/rename or an implicit
fallback. An uncertain result must be reconciled before retrying.
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
file/version provenance. Future adapters must validate stale options and file
changes without relying on a prior query session.
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
