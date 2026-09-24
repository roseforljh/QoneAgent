import { reportStartup } from "./lib/startup-diagnostic";

reportStartup("Loading application modules");
// Import exactly once. Removing a timed-out module script does not cancel it;
// retrying with new query strings can mount several React roots.
void import("./main");
