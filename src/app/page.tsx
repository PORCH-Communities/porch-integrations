const workflows = [
  {
    name: "Givebutter to HubSpot household sync",
    status: "Foundation",
    nextStep: "Build /api/sync-household around the Givebutter household API.",
  },
  {
    name: "Household matching engine",
    status: "Implemented locally",
    nextStep: "Deploy the transaction-flow integration and run a controlled live canary.",
  },
  {
    name: "Framer to HubSpot form processing",
    status: "Candidate",
    nextStep: "Inventory existing Framer form components and current HubSpot submission path.",
  },
];

const endpoints = [
  {
    method: "POST",
    path: "/api/sync-household",
    purpose: "Create or update a Givebutter household from a confirmed HubSpot household.",
  },
  {
    method: "POST",
    path: "/api/match-household",
    purpose: "Score a Givebutter or HubSpot contact against candidate HubSpot household companies.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f7f8f3] text-[#17201a]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-8 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-[#d8decd] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-[#55715b]">
              PORCH operations
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-[#17201a] sm:text-4xl">
              Integrations control room
            </h1>
          </div>
          <div className="rounded-md border border-[#c8d2bd] bg-white px-4 py-3 text-sm text-[#445047] shadow-sm">
            Vercel App Router project for donor, CRM, and form workflows.
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          {workflows.map((workflow) => (
            <article
              className="rounded-md border border-[#d8decd] bg-white p-5 shadow-sm"
              key={workflow.name}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{workflow.name}</h2>
                <span className="rounded-sm bg-[#e7efe1] px-2 py-1 font-mono text-xs text-[#35523c]">
                  {workflow.status}
                </span>
              </div>
              <p className="mt-4 text-sm leading-6 text-[#4c574f]">{workflow.nextStep}</p>
            </article>
          ))}
        </section>

        <section>
          <h2 className="text-xl font-semibold">API surface</h2>
          <div className="mt-4 overflow-hidden rounded-md border border-[#d8decd] bg-white shadow-sm">
            {endpoints.map((endpoint) => (
              <div
                className="grid gap-2 border-b border-[#edf0e8] p-4 last:border-b-0 sm:grid-cols-[120px_1fr]"
                key={endpoint.path}
              >
                <div className="font-mono text-sm text-[#35523c]">
                  {endpoint.method} {endpoint.path}
                </div>
                <p className="text-sm leading-6 text-[#4c574f]">{endpoint.purpose}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
