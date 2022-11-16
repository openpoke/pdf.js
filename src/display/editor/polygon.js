
import {
  AnnotationEditorParamsType,
  AnnotationEditorType,
  Util,
} from "../../shared/util.js";
import { AnnotationEditor } from "./editor.js";
import { opacityToHex } from "./tools.js";
import { fitCurve } from "pdfjs-fitCurve";


// The dimensions of the resizer is 15x15:
// https://searchfox.org/mozilla-central/rev/1ce190047b9556c3c10ab4de70a0e61d893e2954/toolkit/content/minimal-xul.css#136-137
// so each dimension must be greater than RESIZER_SIZE.
const RESIZER_SIZE = 16;

// Some dimensions aren't in percent and that leads to some errors
// when the page is zoomed (see #15571).
const TIME_TO_WAIT_BEFORE_FIXING_DIMS = 100;


class PolygonEditor extends AnnotationEditor {
#aspectRatio = 0;

  #baseHeight = 0;

  #baseWidth = 0;

  #boundCanvasPointermove = this.canvasPointermove.bind(this);

  #boundCanvasPointerleave = this.canvasPointerleave.bind(this);

  #boundCanvasPointerup = this.canvasPointerup.bind(this);

  #boundCanvasPointerdown = this.canvasPointerdown.bind(this);

  #disableEditing = false;

  #isCanvasInitialized = false;

  #lastPoint = null;

  #observer = null;

  #realWidth = 0;

  #realHeight = 0;

  #requestFrameCallback = null;

  static _defaultColor = null;

  static _defaultOpacity = 1;

  static _defaultThickness = 1;

  static _l10nPromise;

  static _type = "polygon";

  constructor(params) {
    super({ ...params, name: "polygonEditor" });
    this.color = params.color || null;
    this.thickness = params.thickness || null;
    this.opacity = params.opacity || null;
    this.paths = [];
//    this.bezierPath2D = [];
    this.currentPath = [];
    this.scaleFactor = 1;
    this.translationX = this.translationY = 0;
    this.x = 0;
    this.y = 0;
  }

  static initialize(l10n) {
    this._l10nPromise = new Map(
      ["editor_ink_canvas_aria_label", "editor_ink2_aria_label"].map(str => [
        str,
        l10n.get(str),
      ])
    );
  }

  static updateDefaultParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.POLYGON_THICKNESS:
        PolygonEditor._defaultThickness = value;
        break;
      case AnnotationEditorParamsType.POLYGON_COLOR:
        PolygonEditor._defaultColor = value;
        break;
      case AnnotationEditorParamsType.POLYGON_OPACITY:
        PolygonEditor._defaultOpacity = value / 100;
        break;
    }
  }

  /** @inheritdoc */
  updateParams(type, value) {
    switch (type) {
      case AnnotationEditorParamsType.POLYGON_THICKNESS:
        this.#updateThickness(value);
        break;
      case AnnotationEditorParamsType.POLYGON_COLOR:
        this.#updateColor(value);
        break;
      case AnnotationEditorParamsType.POLYGON_OPACITY:
        this.#updateOpacity(value);
        break;
    }
  }

  static get defaultPropertiesToUpdate() {
    return [
      [AnnotationEditorParamsType.POLYGON_THICKNESS, PolygonEditor._defaultThickness],
      [
        AnnotationEditorParamsType.POLYGON_COLOR,
        PolygonEditor._defaultColor || AnnotationEditor._defaultLineColor,
      ],
      [
        AnnotationEditorParamsType.POLYGON_OPACITY,
        Math.round(PolygonEditor._defaultOpacity * 100),
      ],
    ];
  }

  /** @inheritdoc */
  get propertiesToUpdate() {
    return [
      [
        AnnotationEditorParamsType.POLYGON_THICKNESS,
        this.thickness || PolygonEditor._defaultThickness,
      ],
      [
        AnnotationEditorParamsType.POLYGON_COLOR,
        this.color ||
          PolygonEditor._defaultColor ||
          AnnotationEditor._defaultLineColor,
      ],
      [
        AnnotationEditorParamsType.POLYGON_OPACITY,
        Math.round(100 * (this.opacity ?? PolygonEditor._defaultOpacity)),
      ],
    ];
  }

  /**
   * Update the thickness and make this action undoable.
   * @param {number} thickness
   */
  #updateThickness(thickness) {
    const savedThickness = this.thickness;
    this.parent.addCommands({
      cmd: () => {
        this.thickness = thickness;
        this.#fitToContent();
      },
      undo: () => {
        this.thickness = savedThickness;
        this.#fitToContent();
      },
      mustExec: true,
      type: AnnotationEditorParamsType.POLYGON_THICKNESS,
      overwriteIfSameType: true,
      keepUndo: true,
    });
  }

  /**
   * Update the color and make this action undoable.
   * @param {string} color
   */
  #updateColor(color) {
    const savedColor = this.color;
    this.parent.addCommands({
      cmd: () => {
        this.color = color;
        this.#redraw();
      },
      undo: () => {
        this.color = savedColor;
        this.#redraw();
      },
      mustExec: true,
      type: AnnotationEditorParamsType.POLYGON_COLOR,
      overwriteIfSameType: true,
      keepUndo: true,
    });
  }

  /**
   * Update the opacity and make this action undoable.
   * @param {number} opacity
   */
  #updateOpacity(opacity) {
    opacity /= 100;
    const savedOpacity = this.opacity;
    this.parent.addCommands({
      cmd: () => {
        this.opacity = opacity;
        this.#redraw();
      },
      undo: () => {
        this.opacity = savedOpacity;
        this.#redraw();
      },
      mustExec: true,
      type: AnnotationEditorParamsType.POLYGON_OPACITY,
      overwriteIfSameType: true,
      keepUndo: true,
    });
  }

  /** @inheritdoc */
  rebuild() {
    super.rebuild();
    if (this.div === null) {
      return;
    }

    if (!this.canvas) {
      this.#createCanvas();
      this.#createObserver();
    }

    if (!this.isAttachedToDOM) {
      // At some point this editor was removed and we're rebuilding it,
      // hence we must add it to its parent.
      this.parent.add(this);
      this.#setCanvasDims();
    }
    this.#fitToContent();
  }

  /** @inheritdoc */
  remove() {
    if (this.canvas === null) {
      return;
    }

    if (!this.isEmpty()) {
      this.commit();
    }

    // Destroy the canvas.
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
    this.canvas = null;

    this.#observer.disconnect();
    this.#observer = null;

    super.remove();

    // fire up an event
    document.dispatchEvent((new CustomEvent('polygonsRemoved', { detail: this.serialize() })));
  }

  /** @inheritdoc */
  enableEditMode() {
    if (this.#disableEditing || this.canvas === null) {
      return;
    }

    super.enableEditMode();
    this.div.draggable = false;
    this.canvas.addEventListener("pointerdown", this.#boundCanvasPointerdown);
    this.canvas.addEventListener("pointerup", this.#boundCanvasPointerup);
  }

  /** @inheritdoc */
  disableEditMode() {
    if (!this.isInEditMode() || this.canvas === null) {
      return;
    }

    super.disableEditMode();
    this.div.draggable = !this.isEmpty();
    this.div.classList.remove("editing");

    this.canvas.removeEventListener("pointerdown", this.#boundCanvasPointerdown);
    this.canvas.removeEventListener("pointerup", this.#boundCanvasPointerup);
  }

  /** @inheritdoc */
  onceAdded() {
    this.div.draggable = !this.isEmpty();
  }

  /** @inheritdoc */
  isEmpty() {
    return (
      this.paths.length === 0 ||
      (this.paths.length === 1 && this.paths[0].length === 0)
    );
  }

  #getInitialBBox() {
    const { width, height, rotation } = this.parent.viewport;
    switch (rotation) {
      case 90:
        return [0, width, width, height];
      case 180:
        return [width, height, width, height];
      case 270:
        return [height, 0, width, height];
      default:
        return [0, 0, width, height];
    }
  }

  /**
   * Set line styles.
   */
  #setStroke() {
    this.ctx.lineWidth =
      (this.thickness * this.parent.scaleFactor) / this.scaleFactor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.miterLimit = 10;
    this.ctx.strokeStyle = `${this.color}${opacityToHex(this.opacity)}`;
  }

  /**
   * Start to draw on the canvas.
   * @param {number} x
   * @param {number} y
   */
  #startDrawing(x, y) {
    this.isEditing = true;
    if (!this.#isCanvasInitialized) {
      this.#isCanvasInitialized = true;
      this.#setCanvasDims();
      this.thickness ||= PolygonEditor._defaultThickness;
      this.color ||=
        PolygonEditor._defaultColor || AnnotationEditor._defaultLineColor;
      this.opacity ??= PolygonEditor._defaultOpacity;
    }
    this.currentPath.push([x, y,0,0]);
    this.#lastPoint = null;
    this.#setStroke();
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);

    this.#requestFrameCallback = () => {
      if (!this.#requestFrameCallback) {
        return;
      }
      if (this.#lastPoint) {
        if (this.isEmpty()) {
          this.ctx.setTransform(1, 0, 0, 1, 0, 0);
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        } else {
          this.#redraw();
        }

        let width = x - this.currentPath[0][0];
        let height = y - this.currentPath[0][1];
//        this.ctx.lineTo(...this.#lastPoint);
        this.ctx.strokeRect(this.currentPath[0][0], this.currentPath[0][1], width, height);
        this.#lastPoint = null;
        this.ctx.stroke();
      }

      window.requestAnimationFrame(this.#requestFrameCallback);
    };
    window.requestAnimationFrame(this.#requestFrameCallback);
  }

  /**
   * Draw on the canvas.
   * @param {number} x
   * @param {number} y
   */
  #draw(x, y) {
    const [lastX, lastY, w, h] = this.currentPath.at(-1);
    if (x === lastX && y === lastY) {
      return;
    }
    let width = x - this.currentPath[0][0];
    let height = y - this.currentPath[0][1];
    this.#lastPoint = [this.currentPath[0][0], this.currentPath[0][1], width, height];

    this.ctx.strokeRect(...this.#lastPoint);

    this.currentPath.push(this.#lastPoint);
  }


  /**
   * Stop to draw on the canvas.
   * @param {number} x
   * @param {number} y
   */
  #stopDrawing(x, y) {
    this.ctx.closePath();
    this.#requestFrameCallback = null;
    let width = x - this.currentPath[0][0];
    let height = y - this.currentPath[0][1];

    let coordinates = [this.currentPath[0][0], this.currentPath[0][1], width, height];


    x = Math.min(Math.max(x, 0), this.canvas.width);
    y = Math.min(Math.max(y, 0), this.canvas.height);

    const [lastX, lastY, w, h] = this.currentPath.at(-1);
    if (x !== lastX || y !== lastY) {
      this.currentPath.push(coordinates);
    }
    this.ctx.strokeRect(...coordinates);

    this.currentPath.length = 0;

    const cmd = () => {
      this.paths.push(coordinates);
      this.rebuild();
    };

    const undo = () => {
      this.paths.pop();
      if (this.paths.length === 0) {
        this.remove();
      } else {
        if (!this.canvas) {
          this.#createCanvas();
          this.#createObserver();
        }
        this.#fitToContent();
      }
    };

    this.parent.addCommands({ cmd, undo, mustExec: true });
  }
  /**
   * Redraw all the paths.
   */
  #redraw() {
    if (this.isEmpty()) {
      this.#updateTransform();
      return;
    }
    this.#setStroke();

    const { canvas, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.#updateTransform();
    for (const path of this.paths) {
        this.ctx.strokeRect(...path);
    }
  }

  /**
   * Commit the curves we have in this editor.
   */
  commit() {
    if (this.#disableEditing) {
      return;
    }

    super.commit();

    // fire up an event
    this.#fireEvents();

    this.isEditing = false;
    this.disableEditMode();

    // This editor must be on top of the main ink editor.
    this.setInForeground();

    this.#disableEditing = true;
    this.div.classList.add("disabled");

    this.#fitToContent(/* firstTime = */ true);

    this.parent.addPolygonEditorIfNeeded(/* isCommitting = */ true);

    // When commiting, the position of this editor is changed, hence we must
    // move it to the right position in the DOM.
    this.parent.moveEditorInDOM(this);
    // After the div has been moved in the DOM, the focus may have been stolen
    // by document.body, hence we just keep it here.
    this.div.focus();

  }

  /** @inheritdoc */
  focusin(event) {
    super.focusin(event);
    this.enableEditMode();
  }

  /**
   * onpointerdown callback for the canvas we're drawing on.
   * @param {PointerEvent} event
   */
  canvasPointerdown(event) {
    if (event.button !== 0 || !this.isInEditMode() || this.#disableEditing) {
      return;
    }

    // We want to draw on top of any other editors.
    // Since it's the last child, there's no need to give it a higher z-index.
    this.setInForeground();

    if (event.type !== "mouse") {
      this.div.focus();
    }

    event.stopPropagation();

    this.canvas.addEventListener("pointerleave", this.#boundCanvasPointerleave);
    this.canvas.addEventListener("pointermove", this.#boundCanvasPointermove);

    this.#startDrawing(event.offsetX, event.offsetY);
  }

  /**
   * onpointermove callback for the canvas we're drawing on.
   * @param {PointerEvent} event
   */
  canvasPointermove(event) {
    event.stopPropagation();
    this.#draw(event.offsetX, event.offsetY);
  }

  /**
   * onpointerup callback for the canvas we're drawing on.
   * @param {PointerEvent} event
   */
  canvasPointerup(event) {
    if (event.button !== 0) {
      return;
    }
    if (this.isInEditMode() && this.currentPath.length !== 0) {
      event.stopPropagation();
      this.#endDrawing(event);

      // Since the ink editor covers all of the page and we want to be able
      // to select another editor, we just put this one in the background.
      this.setInBackground();
    }
  }

  /**
   * onpointerleave callback for the canvas we're drawing on.
   * @param {PointerEvent} event
   */
  canvasPointerleave(event) {
    this.#endDrawing(event);
    this.setInBackground();
  }

  /**
   * End the drawing.
   * @param {PointerEvent} event
   */
  #endDrawing(event) {
    this.#stopDrawing(event.offsetX, event.offsetY);

    this.canvas.removeEventListener(
      "pointerleave",
      this.#boundCanvasPointerleave
    );
    this.canvas.removeEventListener(
      "pointermove",
      this.#boundCanvasPointermove
    );

    this.parent.addToAnnotationStorage(this);
  }

  /**
   * Create the canvas element.
   */
  #createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = 0;
    this.canvas.className = "polygonEditorCanvas";

    PolygonEditor._l10nPromise
      .get("editor_ink_canvas_aria_label")
      .then(msg => this.canvas?.setAttribute("aria-label", msg));
    this.div.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
  }

  /**
   * Create the resize observer.
   */
  #createObserver() {
    let timeoutId = null;
    this.#observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      if (rect.width && rect.height) {
        // Workaround for:
        // https://bugzilla.mozilla.org/show_bug.cgi?id=1795536
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
          this.fixDims();
          timeoutId = null;
        }, TIME_TO_WAIT_BEFORE_FIXING_DIMS);

        this.setDimensions(rect.width, rect.height);
      }
    });
    this.#observer.observe(this.div);
  }

  /** @inheritdoc */
  render() {
    if (this.div) {
      return this.div;
    }

    let baseX, baseY;
    if (this.width) {
      baseX = this.x;
      baseY = this.y;
    }

    super.render();

    PolygonEditor._l10nPromise
      .get("editor_ink2_aria_label")
      .then(msg => this.div?.setAttribute("aria-label", msg));

    const [x, y, w, h] = this.#getInitialBBox();
    this.setAt(x, y, 0, 0);
    this.setDims(w, h);

    this.#createCanvas();

    if (this.width) {
      // This editor was created in using copy (ctrl+c).
      const [parentWidth, parentHeight] = this.parent.viewportBaseDimensions;
      this.setAt(
        baseX * parentWidth,
        baseY * parentHeight,
        this.width * parentWidth,
        this.height * parentHeight
      );
      this.#isCanvasInitialized = true;
      this.#setCanvasDims();
      this.setDims(this.width * parentWidth, this.height * parentHeight);
      this.#redraw();
      this.#setMinDims();
      this.div.classList.add("disabled");
    } else {
      this.div.classList.add("editing");
      this.enableEditMode();
    }

    this.#createObserver();

    return this.div;
  }

  #setCanvasDims() {
    if (!this.#isCanvasInitialized) {
      return;
    }
    const [parentWidth, parentHeight] = this.parent.viewportBaseDimensions;
    this.canvas.width = Math.ceil(this.width * parentWidth);
    this.canvas.height = Math.ceil(this.height * parentHeight);
    this.#updateTransform();
  }

  /**
   * When the dimensions of the div change the inner canvas must
   * renew its dimensions, hence it must redraw its own contents.
   * @param {number} width - the new width of the div
   * @param {number} height - the new height of the div
   * @returns
   */
  setDimensions(width, height) {
    const roundedWidth = Math.round(width);
    const roundedHeight = Math.round(height);
    if (
      this.#realWidth === roundedWidth &&
      this.#realHeight === roundedHeight
    ) {
      return;
    }

    this.#realWidth = roundedWidth;
    this.#realHeight = roundedHeight;

    this.canvas.style.visibility = "hidden";

    if (
      this.#aspectRatio &&
      Math.abs(this.#aspectRatio - width / height) > 1e-2
    ) {
      height = Math.ceil(width / this.#aspectRatio);
      this.setDims(width, height);
    }

    const [parentWidth, parentHeight] = this.parent.viewportBaseDimensions;
    this.width = width / parentWidth;
    this.height = height / parentHeight;

    if (this.#disableEditing) {
      this.#setScaleFactor(width, height);
    }

    this.#setCanvasDims();
    this.#redraw();

    this.canvas.style.visibility = "visible";
  }

  #setScaleFactor(width, height) {
    const padding = this.#getPadding();
    const scaleFactorW = (width - padding) / this.#baseWidth;
    const scaleFactorH = (height - padding) / this.#baseHeight;
    this.scaleFactor = Math.min(scaleFactorW, scaleFactorH);
  }

  /**
   * Update the canvas transform.
   */
  #updateTransform() {
    const padding = this.#getPadding() / 2;
    this.ctx.setTransform(
      this.scaleFactor,
      0,
      0,
      this.scaleFactor,
      this.translationX * this.scaleFactor + padding,
      this.translationY * this.scaleFactor + padding
    );
  }

  /**
   * Transform and serialize the paths.
   * @param {number} s - scale factor
   * @param {number} tx - abscissa of the translation
   * @param {number} ty - ordinate of the translation
   * @param {number} h - height of the bounding box
   */
  #serializePaths(s, tx, ty, h) {
    const NUMBER_OF_POINTS_ON_BEZIER_CURVE = 4;
    const paths = [];
    const padding = this.thickness / 2;
    let buffer, points;

    return this.paths;
  }

  /**
   * Get the bounding box containing all the paths.
   * @returns {Array<number>}
   */
  #getBbox() {
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const path of this.paths) {
        xMin = Math.min(xMin, path[0]);
        yMin = Math.min(yMin, path[1]);
        xMax = Math.max(xMax, (path[0] + path[2]));
        yMax = Math.max(yMax, (path[1] + path[3]));
    }
    return [xMin, yMin, xMax, yMax];
  }

  /**
   * The bounding box is computed with null thickness, so we must take
   * it into account for the display.
   * It corresponds to the total padding, hence it should be divided by 2
   * in order to have left/right paddings.
   * @returns {number}
   */
  #getPadding() {
    return this.#disableEditing
      ? Math.ceil(this.thickness * this.parent.scaleFactor)
      : 0;
  }

  /**
   * Set the div position and dimensions in order to fit to
   * the bounding box of the contents.
   * @returns {undefined}
   */
  #fitToContent(firstTime = false) {
    if (this.isEmpty()) {
      return;
    }

    if (!this.#disableEditing) {
      this.#redraw();
      return;
    }

    const bbox = this.#getBbox();
    const padding = this.#getPadding();
    this.#baseWidth = Math.max(RESIZER_SIZE, bbox[2] - bbox[0]);
    this.#baseHeight = Math.max(RESIZER_SIZE, bbox[3] - bbox[1]);

    const width = Math.ceil(padding + this.#baseWidth * this.scaleFactor);
    const height = Math.ceil(padding + this.#baseHeight * this.scaleFactor);

    const [parentWidth, parentHeight] = this.parent.viewportBaseDimensions;
    this.width = width / parentWidth;
    this.height = height / parentHeight;

    this.#aspectRatio = width / height;
    this.#setMinDims();

    const prevTranslationX = this.translationX;
    const prevTranslationY = this.translationY;

    this.translationX = -bbox[0];
    this.translationY = -bbox[1];
    this.#setCanvasDims();
    this.#redraw();

    this.#realWidth = width;
    this.#realHeight = height;

    this.setDims(width, height);
    const unscaledPadding = firstTime ? padding / this.scaleFactor / 2 : 0;
    this.translate(
      prevTranslationX - this.translationX - unscaledPadding,
      prevTranslationY - this.translationY - unscaledPadding
    );
  }

  #setMinDims() {
    const { style } = this.div;
    if (this.#aspectRatio >= 1) {
      style.minHeight = `${RESIZER_SIZE}px`;
      style.minWidth = `${Math.round(this.#aspectRatio * RESIZER_SIZE)}px`;
    } else {
      style.minWidth = `${RESIZER_SIZE}px`;
      style.minHeight = `${Math.round(RESIZER_SIZE / this.#aspectRatio)}px`;
    }
  }

  /** @inheritdoc */
  static deserialize(data, parent) {
    const editor = super.deserialize(data, parent);

    editor.thickness = data.thickness;
    editor.color = Util.makeHexColor(...data.color);
    editor.opacity = data.opacity;

    const [pageWidth, pageHeight] = parent.pageDimensions;
    const width = editor.width * pageWidth;
    const height = editor.height * pageHeight;
    const scaleFactor = parent.scaleFactor;
    const padding = data.thickness / 2;

    editor.#aspectRatio = width / height;
    editor.#disableEditing = true;
    editor.#realWidth = Math.round(width);
    editor.#realHeight = Math.round(height);

    for (const { bezier } of data.paths) {
      const path = [];
      editor.paths.push(path);
      let p0 = scaleFactor * (bezier[0] - padding);
      let p1 = scaleFactor * (height - bezier[1] - padding);
      for (let i = 2, ii = bezier.length; i < ii; i += 6) {
        const p10 = scaleFactor * (bezier[i] - padding);
        const p11 = scaleFactor * (height - bezier[i + 1] - padding);
        const p20 = scaleFactor * (bezier[i + 2] - padding);
        const p21 = scaleFactor * (height - bezier[i + 3] - padding);
        const p30 = scaleFactor * (bezier[i + 4] - padding);
        const p31 = scaleFactor * (height - bezier[i + 5] - padding);
        path.push([
          [p0, p1],
          [p10, p11],
          [p20, p21],
          [p30, p31],
        ]);
        p0 = p30;
        p1 = p31;
      }
//      const path2D = this.#buildPath2D(path);
//      editor.bezierPath2D.push(path2D);
    }

    const bbox = editor.#getBbox();
    editor.#baseWidth = Math.max(RESIZER_SIZE, bbox[2] - bbox[0]);
    editor.#baseHeight = Math.max(RESIZER_SIZE, bbox[3] - bbox[1]);
    editor.#setScaleFactor(width, height);

    return editor;
  }

  #fireEvents() {
    let serialized = this.serialize();

    if (serialized == null) {
      return;
    }

    for (const path of this.paths) {
      serialized["paths"] = path;
      document.dispatchEvent((new CustomEvent('polygonsAdded', { detail: serialized })));
    }
  }

  /** @inheritdoc */
  serialize() {
    if (this.isEmpty()) {
      return null;
    }

    const rect = this.getRect(0, 0);
    const height =
      this.rotation % 180 === 0 ? rect[3] - rect[1] : rect[2] - rect[0];

    const color = AnnotationEditor._colorManager.convert(this.ctx.strokeStyle);

    return {
      annotationType: AnnotationEditorType.POLYGON,
      color,
      thickness: this.thickness,
      opacity: this.opacity,
      scale: this.scaleFactor / this.parent.scaleFactor,
      paths: this.#serializePaths(
        this.scaleFactor / this.parent.scaleFactor,
        this.translationX,
        this.translationY,
        height
      ),
      pageIndex: this.parent.pageIndex,
      rect,
      rotation: this.rotation,
    };
  }
}
export { PolygonEditor };
