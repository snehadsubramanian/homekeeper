import type { D1Migration } from "cloudflare:test";
import type { AppVars } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppVars {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
