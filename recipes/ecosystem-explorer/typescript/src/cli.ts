#!/usr/bin/env node
/** Command line entry point: firmable-ecosystem-explorer. */
import { runMain } from "firmable-api-client";
import { RECIPE } from "./recipe.js";

runMain(RECIPE);
