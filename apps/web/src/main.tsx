import { Buffer } from "buffer";
if (typeof window !== "undefined") {
  (window as any).Buffer = (window as any).Buffer || Buffer;
  (window as any).global = (window as any).global || window;
}

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import "./index.css";
import { DebugPage } from "./pages/DebugPage";
import { AppPage } from "./pages/AppPage";

function Shell() {
  return (
    <div className="min-h-screen">
      <nav className="flex gap-4 border-b border-graphite px-4 py-3 text-sm">
        <span className="text-amber">zk-pay-starter</span>
        <NavLink to="/debug" className="underline">
          /debug
        </NavLink>
        <NavLink to="/app" className="underline">
          /app
        </NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<DebugPage />} />
        <Route path="/debug" element={<DebugPage />} />
        <Route path="/app" element={<AppPage />} />
      </Routes>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </React.StrictMode>,
);
