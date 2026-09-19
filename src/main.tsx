import React from "react";
import ReactDOM from "react-dom/client";
import { LazyMotion, MotionConfig } from "motion/react";
import { App } from "./App";
import "./styles.css";

const loadMotionFeatures = () =>
  import("./motion-features").then((module) => module.default);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </LazyMotion>
  </React.StrictMode>,
);
