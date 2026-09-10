import { registerMicroAgentKind } from "@areelai/micro-agent";

// A few suites here parse a Micro Agent definition to exercise the shared
// envelope (timeouts, hosted-tool options); the kind must be registered first.
registerMicroAgentKind();
