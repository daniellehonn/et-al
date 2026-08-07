// The store: pages and collections are the primitives; roles.ts keeps the typed
// surface (tasks, sources, insights, decisions) addressable on top of them.
// Every function takes a Ctx carrying the actor, so writes are attributed.
export * from "./db";
export * from "./pages";
export * from "./collections";
export * from "./blocks";
export * from "./roles";
export * from "./relations";
export * from "./daily";
export * from "./search";
export * from "./health";
export * from "./context";
export * from "./home";
export * from "./automations";
