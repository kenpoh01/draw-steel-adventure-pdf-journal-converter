/**

* Draw Steel Adventure PDF Journal Converter
* Main module entry point.
*
* Responsibilities:
* * Initialize the module.
* * Register the import interface.
*
* PDF loading, parsing, and journal creation are handled by their
* respective modules.
  */

import { registerImportButton } from "./ui/importDialog.js";

/**

* Initialize the module when Foundry is ready to initialize modules.
  */
  Hooks.once("init", () => {
  console.log("Draw Steel Adventure PDF Journal Converter | Initializing");

registerImportButton();
});
