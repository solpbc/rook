#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { runCli } from "../src/cli.js";

process.exitCode = await runCli();
