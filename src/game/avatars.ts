/** プリセットアバター。画像素材を使わず Canvas で描く */
export const AVATARS: Record<string, string> = {
  slime: "スライム",
  cat: "ねこ",
  robot: "ロボ",
  ghost: "おばけ",
};
export const AVATAR_KEYS = Object.keys(AVATARS);

/** (x, y) を足元の中心として、高さ約 32px のアバターを描く */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  kind: string,
  x: number,
  y: number,
  color: string,
  t: number,
  walking = false,
) {
  const bob = walking ? Math.sin(t / 90) * 2 : Math.sin(t / 600) * 1;
  ctx.save();
  ctx.translate(x, y + bob);
  // 影
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(0, 2 - bob, 13, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 2;
  switch (kind) {
    case "cat": {
      ctx.beginPath();
      ctx.moveTo(-12, -22);
      ctx.lineTo(-9, -34);
      ctx.lineTo(-3, -26);
      ctx.lineTo(3, -26);
      ctx.lineTo(9, -34);
      ctx.lineTo(12, -22);
      ctx.quadraticCurveTo(14, 0, 0, 0);
      ctx.quadraticCurveTo(-14, 0, -12, -22);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "robot": {
      ctx.beginPath();
      ctx.roundRect(-12, -28, 24, 26, 4);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -28);
      ctx.lineTo(0, -35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -36, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "ghost": {
      ctx.beginPath();
      ctx.moveTo(-12, -2);
      ctx.lineTo(-12, -18);
      ctx.arc(0, -18, 12, Math.PI, 0);
      ctx.lineTo(12, -2);
      for (let i = 0; i < 4; i++) {
        const sx = 12 - i * 6;
        ctx.quadraticCurveTo(sx - 3, -7 + Math.sin(t / 150 + i) * 2, sx - 6, -2);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    default: {
      // slime
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.quadraticCurveTo(-14, -26, 0, -28);
      ctx.quadraticCurveTo(14, -26, 14, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  // 目
  ctx.fillStyle = kind === "robot" ? "#fff" : "#1b1b1b";
  const ey = kind === "slime" ? -14 : -17;
  ctx.beginPath();
  ctx.arc(-5, ey, 2.4, 0, Math.PI * 2);
  ctx.arc(5, ey, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
