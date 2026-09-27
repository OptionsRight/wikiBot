import { render } from "../vendor/preact.module.js";
import { html } from "./html.js";
import App from "./app.js";

render(html`<${App} />`, document.getElementById("app"));
