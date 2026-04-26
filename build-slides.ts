import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs') as any;

/**
 * SealedBid pitch deck builder.
 * Produces SealedBid.pptx in the project root.
 *
 * Design system from SLIDES.md:
 *   bg:        #0A0A1F (dark navy)
 *   primary:   #F5F5FA (off-white)
 *   secondary: #9CA3D9 (muted blue)
 *   brand:     #9945FF (Solana purple)
 *   live:      #14F195 (Solana green)
 *   hero:      #E91E63 (magenta — only on slide 5 banner)
 *
 * 4px purple left bar on slides 2, 3, 5, 6.  Title (1) and demo (4) skip it.
 */

const C = {
  bg: '0A0A1F',
  primary: 'F5F5FA',
  secondary: '9CA3D9',
  brand: '9945FF',
  live: '14F195',
  hero: 'E91E63',
};

const HEAD = 'Arial Black';
const BODY = 'Inter';

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

const pres = new PptxGenJS();
pres.layout = 'LAYOUT_WIDE';
pres.title = 'SealedBid';

pres.defineSlideMaster({
  title: 'BASE',
  background: { color: C.bg },
});

function addLeftBar(slide: any) {
  // Slight inset (x=0.04) avoids Keynote clipping shapes flush to the slide edge.
  // 0.12" reads as a clear, deliberate accent at projector scale.
  slide.addShape('rect', {
    x: 0.04, y: 0, w: 0.12, h: SLIDE_H,
    fill: { color: C.brand },
    line: { type: 'none' },
  });
}

// ---------- Slide 1: Title ----------
{
  const s = pres.addSlide({ masterName: 'BASE' });

  s.addText('MAGICBLOCK INTERNAL BLITZ', {
    x: 0, y: 1.4, w: SLIDE_W, h: 0.4,
    fontSize: 12, fontFace: BODY,
    color: C.secondary, align: 'center', charSpacing: 20,
  });

  // Lock icon circle (Solana purple, ~80px = 0.83")
  const circleSize = 0.9;
  s.addShape('ellipse', {
    x: (SLIDE_W - circleSize) / 2, y: 2.05, w: circleSize, h: circleSize,
    fill: { color: C.brand },
    line: { type: 'none' },
  });
  s.addText('🔒', {
    x: (SLIDE_W - circleSize) / 2, y: 2.05, w: circleSize, h: circleSize,
    fontSize: 40, fontFace: BODY,
    color: C.primary, align: 'center', valign: 'middle',
  });

  s.addText('SealedBid', {
    x: 0, y: 3.2, w: SLIDE_W, h: 1.4,
    fontSize: 80, fontFace: HEAD, color: C.primary,
    bold: true, align: 'center', valign: 'middle',
  });

  s.addText('The agent economy needs sealed-bid auctions. We built one.', {
    x: 0, y: 4.7, w: SLIDE_W, h: 0.6,
    fontSize: 24, fontFace: BODY, color: C.secondary,
    italic: true, align: 'center', valign: 'middle',
  });

  s.addText('Vincent · April 2026', {
    x: 0.5, y: 7.0, w: 5, h: 0.3,
    fontSize: 11, fontFace: BODY, color: C.secondary,
    align: 'left', valign: 'middle',
  });
  s.addText('Built on MagicBlock Private Ephemeral Rollups', {
    x: SLIDE_W - 5.5, y: 7.0, w: 5, h: 0.3,
    fontSize: 11, fontFace: BODY, color: C.secondary,
    align: 'right', valign: 'middle',
  });
}

// ---------- Slide 2: Problem ----------
{
  const s = pres.addSlide({ masterName: 'BASE' });
  addLeftBar(s);

  s.addText("AI agents need to pay each other. Mainnet can't do it.", {
    x: 0.6, y: 0.5, w: SLIDE_W - 1.2, h: 1.0,
    fontSize: 36, fontFace: HEAD, color: C.primary, bold: true,
    align: 'left', valign: 'top',
  });

  // 3 columns
  const cols = [
    { icon: '⚡', headline: 'Fast', caption: 'Auction rounds need to clear in seconds, not 40' },
    { icon: '🔒', headline: 'Private', caption: 'If bids leak, the cheapest provider gets sniped' },
    { icon: '🪙', headline: 'Cheap', caption: 'A 16x fee gap kills any high-frequency market' },
  ];
  const colWidth = 3.6;
  const colGap = 0.4;
  const totalWidth = cols.length * colWidth + (cols.length - 1) * colGap;
  const startX = (SLIDE_W - totalWidth) / 2;
  const colY = 2.2;
  const iconCircle = 0.8;

  cols.forEach((col, i) => {
    const cx = startX + i * (colWidth + colGap);
    // Icon circle
    const ix = cx + (colWidth - iconCircle) / 2;
    s.addShape('ellipse', {
      x: ix, y: colY, w: iconCircle, h: iconCircle,
      fill: { color: C.brand }, line: { type: 'none' },
    });
    s.addText(col.icon, {
      x: ix, y: colY, w: iconCircle, h: iconCircle,
      fontSize: 32, fontFace: BODY, color: C.primary,
      align: 'center', valign: 'middle',
    });

    s.addText(col.headline, {
      x: cx, y: colY + iconCircle + 0.3, w: colWidth, h: 0.6,
      fontSize: 28, fontFace: HEAD, color: C.primary, bold: true,
      align: 'center', valign: 'top',
    });

    s.addText(col.caption, {
      x: cx, y: colY + iconCircle + 1.0, w: colWidth, h: 1.4,
      fontSize: 16, fontFace: BODY, color: C.secondary,
      align: 'center', valign: 'top',
    });
  });

  // Bottom callout
  s.addText('Galaxy projects $3-5T in agent-to-agent commerce by 2030.', {
    x: 0.6, y: 5.7, w: SLIDE_W - 1.2, h: 0.6,
    fontSize: 26, fontFace: BODY, color: C.primary, italic: true,
    align: 'center', valign: 'middle',
  });
  s.addText("Today the rails don't exist.", {
    x: 0.6, y: 6.4, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 18, fontFace: BODY, color: C.secondary,
    align: 'center', valign: 'middle',
  });
}

// ---------- Slide 3: Insight ----------
{
  const s = pres.addSlide({ masterName: 'BASE' });
  addLeftBar(s);

  s.addText('Sealed-bid auctions are the natural shape of agent compute markets.', {
    x: 0.6, y: 0.5, w: SLIDE_W - 1.2, h: 1.4,
    fontSize: 32, fontFace: HEAD, color: C.primary, bold: true,
    align: 'left', valign: 'top',
  });

  // Left text column (~60% of inner width)
  const innerLeft = 0.7;
  const innerWidth = SLIDE_W - 1.4;
  const leftColW = innerWidth * 0.55;
  const colTop = 2.3;

  const para = [
    { text: 'An agent posts a job. Other agents bid in secret. Cheapest wins.', options: { color: C.primary, bold: true, breakLine: true } },
    { text: ' ', options: { breakLine: true } },
    { text: 'Sealed bids stop front-running. But they only work if the auction clears fast enough that the workload is still relevant, and if the bids are hidden inside something more secure than a public mempool.', options: { color: C.secondary, breakLine: true } },
    { text: ' ', options: { breakLine: true } },
    { text: 'Solana can\'t do that.', options: { color: C.secondary, breakLine: true } },
    { text: ' ', options: { breakLine: true } },
    { text: 'A MagicBlock Private Ephemeral Rollup can.', options: { color: C.brand, bold: true } },
  ];
  s.addText(para as any, {
    x: innerLeft, y: colTop, w: leftColW, h: 4.5,
    fontSize: 18, fontFace: BODY,
    align: 'left', valign: 'top', paraSpaceAfter: 6,
  });

  // Right diagram column — 4 stacked rounded rectangles with arrows
  const diagX = innerLeft + leftColW + 0.3;
  const diagW = innerWidth - leftColW - 0.3;
  const boxH = 0.85;
  const arrowH = 0.35;
  const totalDiagH = 4 * boxH + 3 * arrowH;
  const diagTop = colTop + (4.5 - totalDiagH) / 2;

  const steps = [
    { title: 'Seal', sub: 'bids encrypted in TEE' },
    { title: 'Reveal', sub: 'window closes, coordinator decrypts' },
    { title: 'Execute', sub: 'winner runs the task' },
    { title: 'Settle', sub: 'payment lands on Solana' },
  ];

  steps.forEach((step, i) => {
    const y = diagTop + i * (boxH + arrowH);
    s.addShape('roundRect', {
      x: diagX, y, w: diagW, h: boxH,
      fill: { color: C.bg },
      line: { color: C.brand, width: 1 },
      rectRadius: 0.08,
    });
    s.addText(
      [
        { text: step.title, options: { fontSize: 16, fontFace: HEAD, color: C.primary, bold: true, breakLine: true } },
        { text: step.sub, options: { fontSize: 11, fontFace: BODY, color: C.secondary } },
      ] as any,
      { x: diagX + 0.2, y, w: diagW - 0.4, h: boxH, valign: 'middle', align: 'left' },
    );

    if (i < steps.length - 1) {
      // arrow ↓ centered between boxes
      s.addText('↓', {
        x: diagX, y: y + boxH, w: diagW, h: arrowH,
        fontSize: 18, fontFace: BODY, color: C.brand,
        align: 'center', valign: 'middle',
      });
    }
  });
}

// ---------- Slide 4: Demo (marker) ----------
{
  const s = pres.addSlide({ masterName: 'BASE' });
  // No left bar per spec.

  // Top-right LIVE indicator: green dot + "LIVE" text, right-aligned to slide edge
  const dotSize = 0.2;
  const liveBoxW = 0.8;
  const liveBoxX = SLIDE_W - 0.5 - liveBoxW;
  s.addShape('ellipse', {
    x: liveBoxX - dotSize - 0.12, y: 0.5 + (0.4 - dotSize) / 2, w: dotSize, h: dotSize,
    fill: { color: C.live }, line: { type: 'none' },
  });
  s.addText('LIVE', {
    x: liveBoxX, y: 0.5, w: liveBoxW, h: 0.4,
    fontSize: 16, fontFace: HEAD, color: C.live, bold: true,
    align: 'left', valign: 'middle',
  });

  s.addText('DEMO', {
    x: 0, y: 1.8, w: SLIDE_W, h: 4.0,
    fontSize: 200, fontFace: HEAD, color: C.primary, bold: true,
    align: 'center', valign: 'middle',
  });
  s.addText('localhost:5173', {
    x: 0, y: 6.0, w: SLIDE_W, h: 0.6,
    fontSize: 24, fontFace: BODY, color: C.secondary,
    align: 'center', valign: 'middle',
  });
}

// ---------- Slide 5: The numbers ----------
{
  const s = pres.addSlide({ masterName: 'BASE' });
  addLeftBar(s);

  s.addText('What we proved tonight.', {
    x: 0.6, y: 0.5, w: SLIDE_W - 1.2, h: 0.9,
    fontSize: 40, fontFace: HEAD, color: C.primary, bold: true,
    align: 'left', valign: 'top',
  });

  // 2x2 grid. Tall enough for 96pt to actually render at 96pt (≈1.4" line box).
  const cells = [
    { num: '8x', numSize: 96, label: 'faster', sub: '5s vs 40s per auction' },
    { num: '16x', numSize: 96, label: 'cheaper', sub: '0.000142 SOL vs 0.0023 SOL' },
    { num: '50', numSize: 96, label: 'auctions in 60s', sub: 'Parallel, in one PER session' },
    { num: 'TDX-sealed', numSize: 64, label: 'real cryptographic privacy', sub: 'Bids invisible until clearing' },
  ];
  const gridLeft = 0.7;
  const gridTop = 1.55;
  const gridGap = 0.35;
  const cellW = (SLIDE_W - 1.4 - gridGap) / 2;
  const numH = 1.4;
  const labelH = 0.4;
  const subH = 0.35;
  const cellH = numH + labelH + subH;

  cells.forEach((cell, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = gridLeft + col * (cellW + gridGap);
    const y = gridTop + row * (cellH + 0.15);

    s.addText(cell.num, {
      x, y, w: cellW, h: numH,
      fontSize: cell.numSize, fontFace: HEAD, color: C.brand, bold: true,
      align: 'left', valign: 'middle',
    });
    s.addText(cell.label, {
      x, y: y + numH, w: cellW, h: labelH,
      fontSize: 18, fontFace: BODY, color: C.primary, bold: true,
      align: 'left', valign: 'top',
    });
    s.addText(cell.sub, {
      x, y: y + numH + labelH, w: cellW, h: subH,
      fontSize: 13, fontFace: BODY, color: C.secondary,
      align: 'left', valign: 'top',
    });
  });

  // Magenta banner — full width, bottom of slide
  const bannerY = 6.05;
  s.addShape('rect', {
    x: 0.6, y: bannerY, w: SLIDE_W - 1.2, h: 1.25,
    fill: { color: C.hero },
    line: { type: 'none' },
  });
  s.addText('Real on-chain settlement.   Solana Explorer (devnet)', {
    x: 0.8, y: bannerY + 0.1, w: SLIDE_W - 1.6, h: 0.4,
    fontSize: 18, fontFace: HEAD, color: C.primary, bold: true,
    align: 'left', valign: 'middle',
  });
  // URL printed as plain text (not a hyperlink) so the off-white color sticks.
  // PowerPoint's hyperlink theme color overrides explicit colors and renders
  // unreadable on the magenta banner. PowerPoint auto-detects URLs in slideshow
  // mode anyway.
  s.addText(
    'https://explorer.solana.com/tx/2Tdhz5TtHEf2w552cHCBDYH2n635LyDhMxKo6AtVHJThUNQd2miFdyGAB7GwMhs8id8v6zUxReBMVmbzW21TeNNm?cluster=devnet',
    {
      x: 0.8, y: bannerY + 0.55, w: SLIDE_W - 1.6, h: 0.6,
      fontSize: 11, fontFace: 'Menlo', color: 'F5F5FA',
      align: 'left', valign: 'top',
    },
  );
}

// ---------- Slide 6: What this unlocks ----------
{
  const s = pres.addSlide({ masterName: 'BASE' });
  addLeftBar(s);

  s.addText('This is the rail for agentic commerce on Solana.', {
    x: 0.6, y: 0.5, w: SLIDE_W - 1.2, h: 1.0,
    fontSize: 36, fontFace: HEAD, color: C.primary, bold: true,
    align: 'left', valign: 'top',
  });

  const rows = [
    { icon: '🤝', headline: 'Agent compute markets', caption: 'Any agent can hire any other agent. Sealed, settled, on-chain.' },
    { icon: '💳', headline: 'x402 + private payments', caption: 'The only way machine-to-machine stablecoin commerce works at scale.' },
    { icon: '🏛️', headline: 'MiCA-compliant by design', caption: 'Configurable AML, real privacy. Institutions can plug in.' },
  ];
  const rowTop = 1.9;
  const rowH = 0.95;
  const rowGap = 0.25;
  const iconCircle = 0.7;

  rows.forEach((row, i) => {
    const y = rowTop + i * (rowH + rowGap);
    // Icon circle
    s.addShape('ellipse', {
      x: 0.8, y, w: iconCircle, h: iconCircle,
      fill: { color: C.brand }, line: { type: 'none' },
    });
    s.addText(row.icon, {
      x: 0.8, y, w: iconCircle, h: iconCircle,
      fontSize: 24, fontFace: BODY, color: C.primary,
      align: 'center', valign: 'middle',
    });
    s.addText(row.headline, {
      x: 1.7, y, w: SLIDE_W - 2.4, h: 0.45,
      fontSize: 22, fontFace: HEAD, color: C.primary, bold: true,
      align: 'left', valign: 'top',
    });
    s.addText(row.caption, {
      x: 1.7, y: y + 0.45, w: SLIDE_W - 2.4, h: 0.5,
      fontSize: 14, fontFace: BODY, color: C.secondary,
      align: 'left', valign: 'top',
    });
  });

  s.addText('MagicBlock is the only place this works today.', {
    x: 0.6, y: 5.7, w: SLIDE_W - 1.2, h: 0.6,
    fontSize: 28, fontFace: HEAD, color: C.primary, bold: true,
    italic: true, align: 'center', valign: 'middle',
  });
  s.addText('Built on Private Ephemeral Rollups. Open source. Devnet live.', {
    x: 0.6, y: 6.4, w: SLIDE_W - 1.2, h: 0.4,
    fontSize: 14, fontFace: BODY, color: C.secondary,
    align: 'center', valign: 'middle',
  });
}

// ---------- Write file ----------
pres.writeFile({ fileName: 'SealedBid.pptx' }).then((path) => {
  console.log('wrote', path);
});
