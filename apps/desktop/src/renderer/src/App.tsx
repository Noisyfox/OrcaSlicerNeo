export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>OrcaSlicerNeo</h1>
      <p>M0 shell — the WASM slicer and the settings/preview UI land in Milestones 1–2.</p>
      {window.orca ? <p>preload bridge: {window.orca.version}</p> : null}
    </main>
  );
}
