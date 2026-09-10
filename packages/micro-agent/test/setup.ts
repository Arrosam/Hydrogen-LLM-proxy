import { registerMicroAgentKind } from "@areelai/micro-agent";

// Every suite here may parse or run a Micro Agent definition; the gateway
// registers the kind at boot, tests do it once up front.
registerMicroAgentKind();
