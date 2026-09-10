// Build the publishable packages in dependency order (each resolves siblings through dist).
import { execFileSync } from "node:child_process";

const ORDER = ["common", "wire-format", "supplier-management", "user-management", "model-services", "micro-agent"];
for (const name of ORDER) {
  console.log(`\n> @areelai/${name}`);
  execFileSync("npm", ["run", "build", "--workspace", `packages/${name}`], { stdio: "inherit", shell: process.platform === "win32" });
}
