// Entrada <script> para el modo global: expone installGlobal en su propio global.

import { installGlobal } from "./global";

(globalThis as unknown as Record<string, unknown>).IsThatAnAIGlobal = { installGlobal };
