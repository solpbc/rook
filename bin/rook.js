#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { program } from "../src/cli.js";

await program.parseAsync();
