import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  drawTraceToCanvas,
  interpretProgram,
} from "@/lib/turtle";
import type {
  TraceStep,
  TurtleCanvasSpec,
  TurtleProgram,
  TurtleState,
} from "@/lib/turtle";

export interface TurtleCanvasProps {
  program?: TurtleProgram;
  trace?: TraceStep[];
  width?: number;
  height?: number;
  currentStepIndex?: number;
  scaleToFit?: boolean;
  showTurtle?: boolean;
  turtleState?: TurtleState;
  targetImageSrc?: string;
  targetImageOpacity?: number;
  backgroundColor?: string;
  className?: string;
  style?: CSSProperties;
}

export function TurtleCanvas({
  program,
  trace,
  width,
  height,
  currentStepIndex,
  scaleToFit = true,
  showTurtle = true,
  turtleState,
  targetImageSrc,
  targetImageOpacity,
  backgroundColor = "#ffffff",
  className,
  style,
}: TurtleCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [targetImage, setTargetImage] = useState<HTMLImageElement | null>(null);
  const canvasSpec: TurtleCanvasSpec = program?.canvas ?? {
    width: width ?? 640,
    height: height ?? 480,
  };
  const displayWidth = width ?? canvasSpec.width;
  const displayHeight = height ?? canvasSpec.height;
  const pixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const renderedTrace = useMemo(() => trace ?? (program ? interpretProgram(program) : []), [program, trace]);

  useEffect(() => {
    if (!targetImageSrc) {
      setTargetImage(null);
      return;
    }

    const image = new Image();
    image.onload = () => setTargetImage(image);
    image.src = targetImageSrc;
  }, [targetImageSrc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");

    if (!ctx) {
      return;
    }

    drawTraceToCanvas(ctx, renderedTrace, {
      canvas: canvasSpec,
      stepIndex: currentStepIndex,
      scaleToFit,
      backgroundColor,
      targetImage,
      targetImageOpacity,
      showTurtle,
      turtleState,
    });
  }, [
    backgroundColor,
    canvasSpec,
    currentStepIndex,
    renderedTrace,
    scaleToFit,
    showTurtle,
    targetImage,
    targetImageOpacity,
    turtleState,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={Math.round(displayWidth * pixelRatio)}
      height={Math.round(displayHeight * pixelRatio)}
      style={{
        display: "block",
        maxWidth: "100%",
        width: displayWidth,
        height: displayHeight,
        borderRadius: 12,
        ...style,
      }}
    />
  );
}
