// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

const SIZE = 112;
// The print fills the area now that there is no ring around it.
const PRINT_SCALE = 1.4;
const STATES = ['waiting', 'retry', 'fail', 'success', 'off'];

// The fingerprint is a set of ridges wound around a core. Ridge k follows an
// ellipse of radius k * SPACING that drifts outward a little as it turns, so
// the ridges never quite close. Each ridge is a list of arcs, in degrees,
// from 90 (bottom) clockwise through 270 (top) to 450 (bottom again). They
// stay open at the bottom, like a print that stops at the joint, and the two
// ends of a ridge roughly mirror each other so the print stands upright.
const SPACING = 4.5;
const STRETCH = 1.3;
const DRIFT = -0.9;
const SPIRAL = 0.14;
const OFFSET_Y = 11;
const RIDGES = [
    [[148, 395]],
    [[116, 255], [285, 428]],
    [[108, 305], [335, 436]],
    [[120, 205], [232, 352], [380, 424]],
    [[130, 262], [292, 412]],
    [[124, 178], [200, 300], [330, 420]],
    [[140, 236], [256, 288], [308, 402]],
];

function ridgePoint(k, degrees) {
    const angle = degrees * Math.PI / 180;
    const r = (k + SPIRAL * (degrees - 270) / 360) * SPACING;
    return [
        r * Math.cos(angle),
        k * DRIFT + r * STRETCH * Math.sin(angle) + OFFSET_Y,
    ];
}

// One polyline per arc, worked out once.
const STROKES = RIDGES.flatMap((arcs, index) => arcs.map(([from, to]) => {
    const steps = Math.max(8, Math.round((to - from) / 4));
    const points = [];
    for (let i = 0; i <= steps; i++)
        points.push(ridgePoint(index + 1, from + (to - from) * i / steps));
    return {ridge: index, points};
}));

// The fingerprint. The ridges take the colour of the current state and
// move while the reader waits.
export const FingerGlyph = GObject.registerClass(
class FingerGlyph extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'finger-pass-glyph',
            width: SIZE,
            height: SIZE,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._state = 'waiting';
        this._phase = 0;
        this._fill = 0;
    }

    get state() {
        return this._state;
    }

    setState(state) {
        if (state === this._state)
            return;

        for (const name of STATES)
            this.remove_style_class_name(name);
        if (state !== 'waiting')
            this.add_style_class_name(state);

        this._state = state;
        this._fill = 0;
        this.queue_repaint();
    }

    advance(seconds) {
        this._phase += seconds;
        if (this._state === 'success')
            this._fill = Math.min(1, this._fill + seconds / 0.4);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const [r, g, b] = [color.red / 255, color.green / 255, color.blue / 255];
        const alpha = color.alpha / 255;
        const cr = this.get_context();

        const scale = Math.min(width, height) / SIZE;
        cr.translate(width / 2, height / 2);
        cr.scale(scale * PRINT_SCALE, scale * PRINT_SCALE);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Ridges
        cr.setLineWidth(2.3);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        for (const {ridge, points} of STROKES) {
            cr.setSourceRGBA(r, g, b, alpha * this._ridgeAlpha(ridge));
            cr.moveTo(...points[0]);
            for (let i = 1; i < points.length; i++)
                cr.lineTo(...points[i]);
            cr.stroke();
        }

        cr.$dispose();
    }

    _ridgeAlpha(index) {
        switch (this._state) {
        case 'waiting':
            return 0.45 + 0.45 * Math.max(0, Math.sin(this._phase * 3 - index * 0.6));
        case 'success':
            return index < this._fill * RIDGES.length ? 1 : 0.3;
        case 'off':
            return 0.6;
        default:
            return 1;
        }
    }
});
