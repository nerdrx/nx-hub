// The inline-SVG sparkline (SPEC v0.10 [fabric2], DESIGN §1 "cyan = live").
//
// A pure string renderer over lib/sparkline.js's coordinates. Deliberately tiny:
// no axes, no grid, no labels, no fill — the tabular value beside it already
// says what the number IS, and this only says how it has been moving.
//
// Two rules it must not break:
//
//  * **Reduced motion keeps it.** DESIGN §6 freezes decoration; a sparkline is
//    data, so nothing here animates in the first place and nothing is hidden
//    under the media query. What must never appear is a transition on the
//    polyline: the points change several times a second while an app streams,
//    and an eased redraw would turn a status strip into a light show.
//  * **Nothing app-supplied reaches the markup unescaped.** The field key rides
//    in a data attribute and the label rides in the title, and both came off a
//    socket.

import { esc } from '../lib/html.js';
import { sparkPoints, pointsAttr, sparkTitle, SPARK_W, SPARK_H } from '../lib/sparkline.js';

/**
 * @param {Array} history samples for ONE field ({ts, v} entries)
 * @param {{width?:number, height?:number, label?:string, key?:string,
 *          max?:number, title?:string}} opts
 * @returns {string} '' when there is nothing to draw — the caller renders the
 *   plain value and the strip keeps its rhythm.
 */
export function renderSparkline(history, opts = {}) {
  const width = Number(opts.width) > 0 ? Number(opts.width) : SPARK_W;
  const height = Number(opts.height) > 0 ? Number(opts.height) : SPARK_H;
  const spark = sparkPoints(history, { width, height, max: opts.max });
  if (!spark) return '';

  const points = pointsAttr(spark.points);
  if (!points) return '';
  const title = opts.title || sparkTitle(spark, opts.label || opts.key || '');

  // preserveAspectRatio="none" lets the box flex with the strip without the
  // stroke ballooning; vector-effect keeps that stroke exactly 1.5px when it does.
  return `<svg class="spark${spark.flat ? ' spark-flat' : ''}" width="${width}" height="${height}"
      viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" focusable="false"${
        opts.key ? ` data-spark="${esc(opts.key)}"` : ''
      }><title>${esc(title)}</title><polyline points="${esc(points)}" /></svg>`;
}
