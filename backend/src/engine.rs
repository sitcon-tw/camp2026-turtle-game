use std::{io::Cursor, time::Instant};

use image::{DynamicImage, ImageError, ImageFormat, Rgba, RgbaImage, imageops::FilterType};
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_BLOCKS: usize = 500;
pub const MAX_EXPANDED_STEPS: usize = 5_000;
pub const MAX_REPEAT_COUNT: u32 = 100;
pub const MAX_CANVAS_WIDTH: u32 = 1_600;
pub const MAX_CANVAS_HEIGHT: u32 = 1_200;
pub const MAX_EXECUTION_MS: u64 = 5_000;

const DEFAULT_BACKGROUND: Rgba<u8> = Rgba([255, 255, 255, 255]);

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("invalid program json: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("render error: {0}")]
    Render(#[from] ImageError),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlockProgram {
    pub version: u32,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub start: TurtleState,
    pub blocks: Vec<Block>,
}

impl BlockProgram {
    /// Validates structural and execution limits for a block program.
    ///
    /// # Errors
    ///
    /// Returns an [`EngineError::Validation`] when the program exceeds MVP limits
    /// or contains invalid numeric values, colors, repeat counts, or block IDs.
    pub fn validate(&self) -> Result<(), EngineError> {
        if self.canvas_width == 0
            || self.canvas_height == 0
            || self.canvas_width > MAX_CANVAS_WIDTH
            || self.canvas_height > MAX_CANVAS_HEIGHT
        {
            return Err(validation_error("invalid canvas size"));
        }

        self.start.validate()?;

        let stats = validate_blocks(&self.blocks)?;

        if stats.literal_blocks > MAX_BLOCKS {
            return Err(validation_error("too many blocks"));
        }
        if stats.expanded_steps > MAX_EXPANDED_STEPS {
            return Err(validation_error("too many expanded steps"));
        }
        if stats.duration_ms > MAX_EXECUTION_MS {
            return Err(validation_error("execution duration exceeds limit"));
        }

        Ok(())
    }
}

impl<'de> Deserialize<'de> for BlockProgram {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawBlockProgram::deserialize(deserializer)?;
        Ok(raw.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurtleState {
    pub x: f64,
    pub y: f64,
    pub heading_deg: f64,
    pub pen_down: bool,
    pub color: Color,
    pub stroke_width: f64,
}

impl TurtleState {
    #[must_use]
    pub const fn new(
        x: f64,
        y: f64,
        heading_deg: f64,
        pen_down: bool,
        color: Color,
        stroke_width: f64,
    ) -> Self {
        Self {
            x,
            y,
            heading_deg,
            pen_down,
            color,
            stroke_width,
        }
    }

    fn validate(&self) -> Result<(), EngineError> {
        if !self.x.is_finite() || !self.y.is_finite() || !self.heading_deg.is_finite() {
            return Err(validation_error("invalid turtle position or heading"));
        }
        validate_stroke_width(self.stroke_width)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    #[must_use]
    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    #[must_use]
    pub const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self { r, g, b, a }
    }
}

impl Default for Color {
    fn default() -> Self {
        Self::rgb(0, 0, 0)
    }
}

impl From<Color> for Rgba<u8> {
    fn from(color: Color) -> Self {
        Rgba([color.r, color.g, color.b, color.a])
    }
}

impl Serialize for Color {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b))
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        parse_color(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Forward {
        id: String,
        distance: f64,
    },
    Backward {
        id: String,
        distance: f64,
    },
    TurnLeft {
        id: String,
        degrees: f64,
    },
    TurnRight {
        id: String,
        degrees: f64,
    },
    PenUp {
        id: String,
    },
    PenDown {
        id: String,
    },
    SetColor {
        id: String,
        color: Color,
    },
    SetStrokeWidth {
        id: String,
        width: f64,
    },
    Goto {
        id: String,
        x: f64,
        y: f64,
    },
    SetHeading {
        id: String,
        degrees: f64,
    },
    Repeat {
        id: String,
        count: u32,
        blocks: Vec<Block>,
    },
    Clear {
        id: String,
    },
    Wait {
        id: String,
        duration_ms: u64,
    },
}

impl<'de> Deserialize<'de> for Block {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = RawBlock::deserialize(deserializer)?;
        Ok(raw.into())
    }
}

impl Block {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Forward { id, .. }
            | Self::Backward { id, .. }
            | Self::TurnLeft { id, .. }
            | Self::TurnRight { id, .. }
            | Self::PenUp { id }
            | Self::PenDown { id }
            | Self::SetColor { id, .. }
            | Self::SetStrokeWidth { id, .. }
            | Self::Goto { id, .. }
            | Self::SetHeading { id, .. }
            | Self::Repeat { id, .. }
            | Self::Clear { id }
            | Self::Wait { id, .. } => id,
        }
    }

    #[must_use]
    pub const fn block_type(&self) -> &'static str {
        match self {
            Self::Forward { .. } => "forward",
            Self::Backward { .. } => "backward",
            Self::TurnLeft { .. } => "turn_left",
            Self::TurnRight { .. } => "turn_right",
            Self::PenUp { .. } => "pen_up",
            Self::PenDown { .. } => "pen_down",
            Self::SetColor { .. } => "set_color",
            Self::SetStrokeWidth { .. } => "set_stroke_width",
            Self::Goto { .. } => "goto",
            Self::SetHeading { .. } => "set_heading",
            Self::Repeat { .. } => "repeat",
            Self::Clear { .. } => "clear",
            Self::Wait { .. } => "wait",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawBlockProgram {
    Canonical(CanonicalBlockProgram),
    Flattened(FlattenedBlockProgram),
}

impl From<RawBlockProgram> for BlockProgram {
    fn from(raw: RawBlockProgram) -> Self {
        match raw {
            RawBlockProgram::Canonical(program) => program.into(),
            RawBlockProgram::Flattened(program) => program.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalBlockProgram {
    version: u32,
    canvas: CanvasSpec,
    start: CanonicalTurtleState,
    blocks: Vec<Block>,
}

impl From<CanonicalBlockProgram> for BlockProgram {
    fn from(program: CanonicalBlockProgram) -> Self {
        Self {
            version: program.version,
            canvas_width: program.canvas.width,
            canvas_height: program.canvas.height,
            start: program.start.into(),
            blocks: program.blocks,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FlattenedBlockProgram {
    version: u32,
    canvas_width: u32,
    canvas_height: u32,
    start: TurtleState,
    blocks: Vec<Block>,
}

impl From<FlattenedBlockProgram> for BlockProgram {
    fn from(program: FlattenedBlockProgram) -> Self {
        Self {
            version: program.version,
            canvas_width: program.canvas_width,
            canvas_height: program.canvas_height,
            start: program.start,
            blocks: program.blocks,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanvasSpec {
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalTurtleState {
    x: f64,
    y: f64,
    heading: f64,
    pen_down: bool,
    stroke_color: Color,
    stroke_width: f64,
}

impl From<CanonicalTurtleState> for TurtleState {
    fn from(state: CanonicalTurtleState) -> Self {
        Self::new(
            state.x,
            state.y,
            state.heading,
            state.pen_down,
            state.stroke_color,
            state.stroke_width,
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawBlock {
    Canonical(CanonicalBlock),
    Flattened(FlattenedBlock),
}

impl From<RawBlock> for Block {
    fn from(raw: RawBlock) -> Self {
        match raw {
            RawBlock::Canonical(block) => block.into(),
            RawBlock::Flattened(block) => block.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum CanonicalBlock {
    Forward {
        id: String,
        args: DistanceArgs,
    },
    Backward {
        id: String,
        args: DistanceArgs,
    },
    TurnLeft {
        id: String,
        args: DegreesArgs,
    },
    TurnRight {
        id: String,
        args: DegreesArgs,
    },
    PenUp {
        id: String,
        #[serde(default)]
        args: NoArgs,
    },
    PenDown {
        id: String,
        #[serde(default)]
        args: NoArgs,
    },
    SetColor {
        id: String,
        args: ColorArgs,
    },
    SetStrokeWidth {
        id: String,
        args: StrokeWidthArgs,
    },
    Goto {
        id: String,
        args: GotoArgs,
    },
    SetHeading {
        id: String,
        args: HeadingArgs,
    },
    Repeat {
        id: String,
        args: RepeatArgs,
        children: Vec<Block>,
    },
    Clear {
        id: String,
        #[serde(default)]
        args: NoArgs,
    },
    Wait {
        id: String,
        args: WaitArgs,
    },
}

impl From<CanonicalBlock> for Block {
    fn from(block: CanonicalBlock) -> Self {
        match block {
            CanonicalBlock::Forward { id, args } => Self::Forward {
                id,
                distance: args.distance,
            },
            CanonicalBlock::Backward { id, args } => Self::Backward {
                id,
                distance: args.distance,
            },
            CanonicalBlock::TurnLeft { id, args } => Self::TurnLeft {
                id,
                degrees: args.degrees,
            },
            CanonicalBlock::TurnRight { id, args } => Self::TurnRight {
                id,
                degrees: args.degrees,
            },
            CanonicalBlock::PenUp { id, args } => {
                let NoArgs {} = args;
                Self::PenUp { id }
            }
            CanonicalBlock::PenDown { id, args } => {
                let NoArgs {} = args;
                Self::PenDown { id }
            }
            CanonicalBlock::SetColor { id, args } => Self::SetColor {
                id,
                color: args.color,
            },
            CanonicalBlock::SetStrokeWidth { id, args } => Self::SetStrokeWidth {
                id,
                width: args.width,
            },
            CanonicalBlock::Goto { id, args } => Self::Goto {
                id,
                x: args.x,
                y: args.y,
            },
            CanonicalBlock::SetHeading { id, args } => Self::SetHeading {
                id,
                degrees: args.degrees,
            },
            CanonicalBlock::Repeat { id, args, children } => Self::Repeat {
                id,
                count: args.times,
                blocks: children,
            },
            CanonicalBlock::Clear { id, args } => {
                let NoArgs {} = args;
                Self::Clear { id }
            }
            CanonicalBlock::Wait { id, args } => Self::Wait {
                id,
                duration_ms: args.duration_ms,
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum FlattenedBlock {
    Forward {
        id: String,
        distance: f64,
    },
    Backward {
        id: String,
        distance: f64,
    },
    TurnLeft {
        id: String,
        degrees: f64,
    },
    TurnRight {
        id: String,
        degrees: f64,
    },
    PenUp {
        id: String,
    },
    PenDown {
        id: String,
    },
    SetColor {
        id: String,
        color: Color,
    },
    SetStrokeWidth {
        id: String,
        width: f64,
    },
    Goto {
        id: String,
        x: f64,
        y: f64,
    },
    SetHeading {
        id: String,
        degrees: f64,
    },
    Repeat {
        id: String,
        count: u32,
        blocks: Vec<Block>,
    },
    Clear {
        id: String,
    },
    Wait {
        id: String,
        duration_ms: u64,
    },
}

impl From<FlattenedBlock> for Block {
    fn from(block: FlattenedBlock) -> Self {
        match block {
            FlattenedBlock::Forward { id, distance } => Self::Forward { id, distance },
            FlattenedBlock::Backward { id, distance } => Self::Backward { id, distance },
            FlattenedBlock::TurnLeft { id, degrees } => Self::TurnLeft { id, degrees },
            FlattenedBlock::TurnRight { id, degrees } => Self::TurnRight { id, degrees },
            FlattenedBlock::PenUp { id } => Self::PenUp { id },
            FlattenedBlock::PenDown { id } => Self::PenDown { id },
            FlattenedBlock::SetColor { id, color } => Self::SetColor { id, color },
            FlattenedBlock::SetStrokeWidth { id, width } => Self::SetStrokeWidth { id, width },
            FlattenedBlock::Goto { id, x, y } => Self::Goto { id, x, y },
            FlattenedBlock::SetHeading { id, degrees } => Self::SetHeading { id, degrees },
            FlattenedBlock::Repeat { id, count, blocks } => Self::Repeat { id, count, blocks },
            FlattenedBlock::Clear { id } => Self::Clear { id },
            FlattenedBlock::Wait { id, duration_ms } => Self::Wait { id, duration_ms },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DistanceArgs {
    distance: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DegreesArgs {
    degrees: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ColorArgs {
    color: Color,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrokeWidthArgs {
    #[serde(alias = "stroke_width")]
    width: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GotoArgs {
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeadingArgs {
    #[serde(alias = "heading")]
    degrees: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepeatArgs {
    times: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    #[serde(alias = "duration")]
    duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionTrace {
    pub final_state: TurtleState,
    pub steps: Vec<TraceStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceStep {
    pub step_index: usize,
    pub block_id: String,
    pub block_type: String,
    pub before: TurtleState,
    pub after: TurtleState,
    pub draw_line: Option<DrawLine>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrawLine {
    pub from_x: f64,
    pub from_y: f64,
    pub to_x: f64,
    pub to_y: f64,
    pub color: Color,
    pub stroke_width: f64,
}

/// Parses and validates a JSON block program.
///
/// # Errors
///
/// Returns an error when JSON parsing fails or validation rejects the program.
pub fn parse_program_json(json: &str) -> Result<BlockProgram, EngineError> {
    let program = serde_json::from_str::<BlockProgram>(json)?;
    program.validate()?;
    Ok(program)
}

/// Runs a validated block program and returns a deterministic execution trace.
///
/// # Errors
///
/// Returns a validation error when the program is invalid or exceeds limits.
pub fn interpret_program(program: &BlockProgram) -> Result<ExecutionTrace, EngineError> {
    program.validate()?;

    let started_at = Instant::now();
    let mut state = program.start;
    let mut steps = Vec::new();
    execute_blocks_for_trace(&program.blocks, &mut state, &mut steps, started_at)?;

    Ok(ExecutionTrace {
        final_state: state,
        steps,
    })
}

/// Renders a block program into deterministic PNG bytes.
///
/// # Errors
///
/// Returns a validation or PNG encoding error.
pub fn render_program_png(program: &BlockProgram) -> Result<Vec<u8>, EngineError> {
    let image = render_program_image(program)?;
    encode_png(&image)
}

/// Renders a block program into an RGBA image.
///
/// # Errors
///
/// Returns a validation error when the program is invalid or exceeds limits.
pub fn render_program_image(program: &BlockProgram) -> Result<RgbaImage, EngineError> {
    program.validate()?;

    let started_at = Instant::now();
    let mut image = RgbaImage::from_pixel(
        program.canvas_width,
        program.canvas_height,
        DEFAULT_BACKGROUND,
    );
    let mut state = program.start;
    execute_blocks_for_render(&program.blocks, &mut state, &mut image, started_at)?;
    Ok(image)
}

/// Compares two PNG images and returns a score from `0.0` to `1.0`.
///
/// Empty byte slices produce `0.0`; invalid non-empty image data is returned as
/// an image decoding error.
///
/// # Errors
///
/// Returns an image error for malformed non-empty image bytes.
pub fn pixel_similarity_png_bytes(target: &[u8], result: &[u8]) -> Result<f64, EngineError> {
    if target.is_empty() || result.is_empty() {
        return Ok(0.0);
    }

    let target = image::load_from_memory(target)?.into_rgba8();
    let result = image::load_from_memory(result)?.into_rgba8();
    Ok(pixel_similarity_images(&target, &result))
}

#[must_use]
pub fn pixel_similarity_images(target: &RgbaImage, result: &RgbaImage) -> f64 {
    let width = target.width();
    let height = target.height();
    if width == 0 || height == 0 || result.width() == 0 || result.height() == 0 {
        return 0.0;
    }

    let normalized_result = if result.width() == width && result.height() == height {
        result.clone()
    } else {
        image::imageops::resize(result, width, height, FilterType::Nearest)
    };

    let max_diff = f64::from(width) * f64::from(height) * 4.0 * 255.0;
    let total_diff = target
        .pixels()
        .zip(normalized_result.pixels())
        .map(|(left, right)| {
            left.0
                .iter()
                .zip(right.0.iter())
                .map(|(a, b)| (f64::from(*a) - f64::from(*b)).abs())
                .sum::<f64>()
        })
        .sum::<f64>();

    (1.0 - total_diff / max_diff).clamp(0.0, 1.0)
}

fn execute_blocks_for_trace(
    blocks: &[Block],
    state: &mut TurtleState,
    steps: &mut Vec<TraceStep>,
    started_at: Instant,
) -> Result<(), EngineError> {
    for block in blocks {
        check_execution_time(started_at)?;
        match block {
            Block::Repeat { count, blocks, .. } => {
                for _ in 0..*count {
                    execute_blocks_for_trace(blocks, state, steps, started_at)?;
                }
            }
            _ => {
                let before = *state;
                let draw_line = apply_block(block, state);
                let after = *state;
                steps.push(TraceStep {
                    step_index: steps.len(),
                    block_id: block.id().to_owned(),
                    block_type: block.block_type().to_owned(),
                    before,
                    after,
                    draw_line,
                    duration_ms: block_duration_ms(block),
                });
            }
        }
    }
    Ok(())
}

fn execute_blocks_for_render(
    blocks: &[Block],
    state: &mut TurtleState,
    image: &mut RgbaImage,
    started_at: Instant,
) -> Result<(), EngineError> {
    for block in blocks {
        check_execution_time(started_at)?;
        match block {
            Block::Repeat { count, blocks, .. } => {
                for _ in 0..*count {
                    execute_blocks_for_render(blocks, state, image, started_at)?;
                }
            }
            Block::Clear { .. } => {
                clear_image(image);
            }
            _ => {
                if let Some(line) = apply_block(block, state) {
                    draw_line(image, &line);
                }
            }
        }
    }
    Ok(())
}

fn apply_block(block: &Block, state: &mut TurtleState) -> Option<DrawLine> {
    match block {
        Block::Forward { distance, .. } => move_turtle(state, *distance),
        Block::Backward { distance, .. } => move_turtle(state, -*distance),
        Block::TurnLeft { degrees, .. } => {
            state.heading_deg = normalize_heading(state.heading_deg + *degrees);
            None
        }
        Block::TurnRight { degrees, .. } => {
            state.heading_deg = normalize_heading(state.heading_deg - *degrees);
            None
        }
        Block::PenUp { .. } => {
            state.pen_down = false;
            None
        }
        Block::PenDown { .. } => {
            state.pen_down = true;
            None
        }
        Block::SetColor { color, .. } => {
            state.color = *color;
            None
        }
        Block::SetStrokeWidth { width, .. } => {
            state.stroke_width = *width;
            None
        }
        Block::Goto { x, y, .. } => goto(state, *x, *y),
        Block::SetHeading { degrees, .. } => {
            state.heading_deg = normalize_heading(*degrees);
            None
        }
        Block::Repeat { .. } | Block::Clear { .. } | Block::Wait { .. } => None,
    }
}

fn move_turtle(state: &mut TurtleState, distance: f64) -> Option<DrawLine> {
    let radians = state.heading_deg.to_radians();
    let x = state.x + radians.cos() * distance;
    let y = state.y - radians.sin() * distance;
    goto(state, x, y)
}

fn goto(state: &mut TurtleState, x: f64, y: f64) -> Option<DrawLine> {
    let from_x = state.x;
    let from_y = state.y;
    state.x = x;
    state.y = y;

    if state.pen_down {
        Some(DrawLine {
            from_x,
            from_y,
            to_x: x,
            to_y: y,
            color: state.color,
            stroke_width: state.stroke_width,
        })
    } else {
        None
    }
}

fn validate_blocks(blocks: &[Block]) -> Result<ValidationStats, EngineError> {
    let mut stats = ValidationStats::default();

    for block in blocks {
        stats.literal_blocks = stats
            .literal_blocks
            .checked_add(1)
            .ok_or_else(|| validation_error("too many blocks"))?;

        if block.id().trim().is_empty() {
            return Err(validation_error("missing block id"));
        }

        match block {
            Block::Forward { distance, .. } | Block::Backward { distance, .. } => {
                validate_distance(*distance)?;
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, 1)?;
            }
            Block::TurnLeft { degrees, .. }
            | Block::TurnRight { degrees, .. }
            | Block::SetHeading { degrees, .. } => {
                validate_finite(*degrees, "invalid degrees")?;
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, 1)?;
            }
            Block::PenUp { .. }
            | Block::PenDown { .. }
            | Block::Clear { .. }
            | Block::SetColor { .. } => {
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, 1)?;
            }
            Block::SetStrokeWidth { width, .. } => {
                validate_stroke_width(*width)?;
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, 1)?;
            }
            Block::Goto { x, y, .. } => {
                validate_finite(*x, "invalid x")?;
                validate_finite(*y, "invalid y")?;
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, 1)?;
            }
            Block::Repeat { count, blocks, .. } => {
                if *count > MAX_REPEAT_COUNT {
                    return Err(validation_error("repeat count exceeds limit"));
                }
                let child_stats = validate_blocks(blocks)?;
                stats.literal_blocks =
                    add_expanded_steps(stats.literal_blocks, child_stats.literal_blocks)?;
                let repeat_count = usize::try_from(*count)
                    .map_err(|_| validation_error("repeat count exceeds platform capacity"))?;
                let repeated_steps = child_stats
                    .expanded_steps
                    .checked_mul(repeat_count)
                    .ok_or_else(|| validation_error("too many expanded steps"))?;
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, repeated_steps)?;
                let repeated_duration = child_stats
                    .duration_ms
                    .checked_mul(u64::from(*count))
                    .ok_or_else(|| validation_error("execution duration exceeds limit"))?;
                stats.duration_ms = stats
                    .duration_ms
                    .checked_add(repeated_duration)
                    .ok_or_else(|| validation_error("execution duration exceeds limit"))?;
            }
            Block::Wait { duration_ms, .. } => {
                stats.duration_ms = stats
                    .duration_ms
                    .checked_add(*duration_ms)
                    .ok_or_else(|| validation_error("execution duration exceeds limit"))?;
                stats.expanded_steps = add_expanded_steps(stats.expanded_steps, 1)?;
            }
        }
    }

    Ok(stats)
}

fn validate_distance(distance: f64) -> Result<(), EngineError> {
    if !distance.is_finite() || distance < 0.0 {
        return Err(validation_error("invalid distance"));
    }
    Ok(())
}

fn validate_stroke_width(width: f64) -> Result<(), EngineError> {
    if !width.is_finite() || width <= 0.0 {
        return Err(validation_error("invalid stroke width"));
    }
    Ok(())
}

fn validate_finite(value: f64, message: &'static str) -> Result<(), EngineError> {
    if !value.is_finite() {
        return Err(validation_error(message));
    }
    Ok(())
}

fn add_expanded_steps(left: usize, right: usize) -> Result<usize, EngineError> {
    left.checked_add(right)
        .ok_or_else(|| validation_error("too many expanded steps"))
}

fn block_duration_ms(block: &Block) -> u64 {
    match block {
        Block::Wait { duration_ms, .. } => *duration_ms,
        _ => 0,
    }
}

fn check_execution_time(started_at: Instant) -> Result<(), EngineError> {
    let elapsed_ms = match u64::try_from(started_at.elapsed().as_millis()) {
        Ok(value) => value,
        Err(_) => u64::MAX,
    };

    if elapsed_ms > MAX_EXECUTION_MS {
        return Err(validation_error("execution time exceeds limit"));
    }
    Ok(())
}

fn normalize_heading(degrees: f64) -> f64 {
    degrees.rem_euclid(360.0)
}

fn parse_color(value: &str) -> Result<Color, String> {
    let hex = value
        .strip_prefix('#')
        .ok_or_else(|| "invalid color".to_owned())?;

    if hex.len() != 6 && hex.len() != 8 {
        return Err("invalid color".to_owned());
    }

    let r = parse_hex_byte(&hex[0..2])?;
    let g = parse_hex_byte(&hex[2..4])?;
    let b = parse_hex_byte(&hex[4..6])?;
    let a = if hex.len() == 8 {
        parse_hex_byte(&hex[6..8])?
    } else {
        255
    };

    Ok(Color::rgba(r, g, b, a))
}

fn parse_hex_byte(value: &str) -> Result<u8, String> {
    u8::from_str_radix(value, 16).map_err(|_| "invalid color".to_owned())
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, EngineError> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone()).write_to(&mut bytes, ImageFormat::Png)?;
    Ok(bytes.into_inner())
}

fn clear_image(image: &mut RgbaImage) {
    for pixel in image.pixels_mut() {
        *pixel = DEFAULT_BACKGROUND;
    }
}

fn draw_line(image: &mut RgbaImage, line: &DrawLine) {
    let dx = line.to_x - line.from_x;
    let dy = line.to_y - line.from_y;
    let steps = dx.abs().max(dy.abs()).ceil().max(1.0);
    let mut step = 0.0;
    while step <= steps {
        let t = step / steps;
        let x = line.from_x + dx * t;
        let y = line.from_y + dy * t;
        draw_brush(image, x, y, line.stroke_width, Rgba::from(line.color));
        step += 1.0;
    }
}

fn draw_brush(image: &mut RgbaImage, x: f64, y: f64, stroke_width: f64, color: Rgba<u8>) {
    let radius = ((stroke_width.max(1.0) - 1.0) / 2.0).ceil();
    let center_x = x.round();
    let center_y = y.round();
    let min_x = center_x - radius;
    let max_x = center_x + radius;
    let min_y = center_y - radius;
    let max_y = center_y + radius;

    let mut yy = min_y;
    while yy <= max_y {
        let mut xx = min_x;
        while xx <= max_x {
            put_pixel_if_in_bounds(image, xx, yy, color);
            xx += 1.0;
        }
        yy += 1.0;
    }
}

fn put_pixel_if_in_bounds(image: &mut RgbaImage, x: f64, y: f64, color: Rgba<u8>) {
    if x < 0.0 || y < 0.0 || x >= f64::from(image.width()) || y >= f64::from(image.height()) {
        return;
    }

    let Some(x) = f64_to_u32(x) else {
        return;
    };
    let Some(y) = f64_to_u32(y) else {
        return;
    };
    image.put_pixel(x, y, color);
}

fn f64_to_u32(value: f64) -> Option<u32> {
    if value < 0.0 || value > f64::from(u32::MAX) {
        return None;
    }
    value.to_u32()
}

fn validation_error(message: &'static str) -> EngineError {
    EngineError::Validation(message.to_owned())
}

#[derive(Debug, Default)]
struct ValidationStats {
    literal_blocks: usize,
    expanded_steps: usize,
    duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_state() -> TurtleState {
        TurtleState::new(10.0, 10.0, 0.0, true, Color::default(), 1.0)
    }

    fn program(blocks: Vec<Block>) -> BlockProgram {
        BlockProgram {
            version: 1,
            canvas_width: 80,
            canvas_height: 60,
            start: base_state(),
            blocks,
        }
    }

    fn count_non_white(image: &RgbaImage) -> usize {
        image
            .pixels()
            .filter(|pixel| **pixel != DEFAULT_BACKGROUND)
            .count()
    }

    #[test]
    fn canonical_simple_program_parses_validates_and_interprets() -> Result<(), EngineError> {
        let program: BlockProgram = serde_json::from_value(json!({
            "version": 1,
            "canvas": { "width": 800, "height": 600 },
            "start": {
                "x": 400.0,
                "y": 300.0,
                "heading": 0.0,
                "pen_down": true,
                "stroke_color": "#000000",
                "stroke_width": 4.0
            },
            "blocks": [
                { "id": "block-1", "type": "set_color", "args": { "color": "#ff0000" } },
                { "id": "block-2", "type": "forward", "args": { "distance": 100.0 } }
            ]
        }))?;

        assert_eq!(program.canvas_width, 800);
        assert_eq!(program.canvas_height, 600);
        assert_eq!(program.start.color, Color::default());
        assert!((program.start.stroke_width - 4.0).abs() < f64::EPSILON);
        program.validate()?;

        let trace = interpret_program(&program)?;
        assert_eq!(trace.steps.len(), 2);
        assert_eq!(trace.steps[0].block_type, "set_color");
        assert_eq!(trace.steps[1].block_id, "block-2");
        assert_eq!(
            trace.steps[1].draw_line.as_ref().map(|line| line.color),
            Some(Color::rgb(255, 0, 0))
        );
        assert!((trace.final_state.x - 500.0).abs() < f64::EPSILON);
        assert!((trace.final_state.y - 300.0).abs() < f64::EPSILON);

        Ok(())
    }

    #[test]
    fn canonical_repeat_uses_args_times_and_children() -> Result<(), EngineError> {
        let program: BlockProgram = serde_json::from_value(json!({
            "version": 1,
            "canvas": { "width": 120, "height": 120 },
            "start": {
                "x": 60.0,
                "y": 60.0,
                "heading": 0.0,
                "pen_down": true,
                "stroke_color": "#000000",
                "stroke_width": 1.0
            },
            "blocks": [
                {
                    "id": "block-4",
                    "type": "repeat",
                    "args": { "times": 4 },
                    "children": [
                        { "id": "child-forward", "type": "forward", "args": { "distance": 10.0 } },
                        { "id": "child-left", "type": "turn_left", "args": { "degrees": 90.0 } }
                    ]
                }
            ]
        }))?;

        let Block::Repeat { count, blocks, .. } = &program.blocks[0] else {
            panic!("canonical repeat should convert to internal repeat");
        };
        assert_eq!(*count, 4);
        assert_eq!(blocks.len(), 2);

        let trace = interpret_program(&program)?;
        assert_eq!(trace.steps.len(), 8);
        assert_eq!(trace.steps[0].block_id, "child-forward");
        assert_eq!(trace.steps[7].block_id, "child-left");
        assert!((trace.final_state.heading_deg - 0.0).abs() < f64::EPSILON);

        Ok(())
    }

    #[test]
    fn canonical_missing_args_rejected() {
        let result = serde_json::from_value::<BlockProgram>(json!({
            "version": 1,
            "canvas": { "width": 80, "height": 60 },
            "start": {
                "x": 10.0,
                "y": 10.0,
                "heading": 0.0,
                "pen_down": true,
                "stroke_color": "#000000",
                "stroke_width": 1.0
            },
            "blocks": [
                { "id": "move-1", "type": "forward" }
            ]
        }));

        assert!(result.is_err());
    }

    #[test]
    fn canonical_unknown_block_type_rejected() {
        let result = serde_json::from_value::<BlockProgram>(json!({
            "version": 1,
            "canvas": { "width": 80, "height": 60 },
            "start": {
                "x": 10.0,
                "y": 10.0,
                "heading": 0.0,
                "pen_down": true,
                "stroke_color": "#000000",
                "stroke_width": 1.0
            },
            "blocks": [
                { "id": "bad-1", "type": "teleport", "args": { "distance": 12.0 } }
            ]
        }));

        assert!(result.is_err());
    }

    #[test]
    fn parses_valid_program_and_rejects_unknown_block() {
        let json = r##"{
            "version": 1,
            "canvas_width": 80,
            "canvas_height": 60,
            "start": {
                "x": 10.0,
                "y": 10.0,
                "heading_deg": 0.0,
                "pen_down": true,
                "color": "#000000",
                "stroke_width": 1.0
            },
            "blocks": [
                { "type": "forward", "id": "move-1", "distance": 12.0 }
            ]
        }"##;
        let parsed = parse_program_json(json);
        assert!(parsed.is_ok());

        let unknown = json.replace("forward", "teleport");
        let parsed_unknown = parse_program_json(&unknown);
        assert!(parsed_unknown.is_err());
    }

    #[test]
    fn validation_rejects_missing_args_invalid_color_canvas_and_negative_distance() {
        let missing_distance = r##"{
            "version": 1,
            "canvas_width": 80,
            "canvas_height": 60,
            "start": {
                "x": 10.0,
                "y": 10.0,
                "heading_deg": 0.0,
                "pen_down": true,
                "color": "#000000",
                "stroke_width": 1.0
            },
            "blocks": [{ "type": "forward", "id": "move-1" }]
        }"##;
        assert!(parse_program_json(missing_distance).is_err());

        let invalid_color = r##"{
            "version": 1,
            "canvas_width": 80,
            "canvas_height": 60,
            "start": {
                "x": 10.0,
                "y": 10.0,
                "heading_deg": 0.0,
                "pen_down": true,
                "color": "red",
                "stroke_width": 1.0
            },
            "blocks": []
        }"##;
        assert!(parse_program_json(invalid_color).is_err());

        let too_wide = BlockProgram {
            canvas_width: MAX_CANVAS_WIDTH + 1,
            ..program(Vec::new())
        };
        assert!(too_wide.validate().is_err());

        let negative_distance = program(vec![Block::Forward {
            id: "bad-distance".to_owned(),
            distance: -1.0,
        }]);
        assert!(negative_distance.validate().is_err());
    }

    #[test]
    fn validation_rejects_excessive_blocks_repeat_counts_expansion_and_wait_time() {
        let many_blocks = program(
            (0..=MAX_BLOCKS)
                .map(|index| Block::PenUp {
                    id: format!("pen-up-{index}"),
                })
                .collect(),
        );
        assert!(many_blocks.validate().is_err());

        let too_many_repeats = program(vec![Block::Repeat {
            id: "repeat".to_owned(),
            count: MAX_REPEAT_COUNT + 1,
            blocks: vec![Block::PenUp {
                id: "inner".to_owned(),
            }],
        }]);
        assert!(too_many_repeats.validate().is_err());

        let expanded_too_large = program(vec![Block::Repeat {
            id: "outer".to_owned(),
            count: MAX_REPEAT_COUNT,
            blocks: vec![Block::Repeat {
                id: "inner".to_owned(),
                count: MAX_REPEAT_COUNT,
                blocks: vec![Block::PenUp {
                    id: "leaf".to_owned(),
                }],
            }],
        }]);
        assert!(expanded_too_large.validate().is_err());

        let wait_too_long = program(vec![Block::Wait {
            id: "wait".to_owned(),
            duration_ms: MAX_EXECUTION_MS + 1,
        }]);
        assert!(wait_too_long.validate().is_err());
    }

    #[test]
    fn interpreter_moves_turns_and_records_trace_ids() -> Result<(), EngineError> {
        let trace = interpret_program(&program(vec![
            Block::Forward {
                id: "forward-a".to_owned(),
                distance: 10.0,
            },
            Block::TurnLeft {
                id: "left".to_owned(),
                degrees: 90.0,
            },
            Block::Forward {
                id: "forward-b".to_owned(),
                distance: 5.0,
            },
            Block::TurnRight {
                id: "right".to_owned(),
                degrees: 45.0,
            },
        ]))?;

        assert_eq!(trace.steps.len(), 4);
        assert_eq!(trace.steps[0].step_index, 0);
        assert_eq!(trace.steps[0].block_id, "forward-a");
        assert_eq!(trace.steps[0].block_type, "forward");
        assert!(trace.steps[0].draw_line.is_some());
        assert!((trace.final_state.x - 20.0).abs() < f64::EPSILON);
        assert!((trace.final_state.y - 5.0).abs() < 0.000_001);
        assert!((trace.final_state.heading_deg - 45.0).abs() < f64::EPSILON);

        Ok(())
    }

    #[test]
    fn interpreter_handles_pen_color_stroke_repeat_clear_wait_and_determinism()
    -> Result<(), EngineError> {
        let block_program = program(vec![
            Block::PenUp {
                id: "pen-up".to_owned(),
            },
            Block::Forward {
                id: "hidden".to_owned(),
                distance: 5.0,
            },
            Block::PenDown {
                id: "pen-down".to_owned(),
            },
            Block::SetColor {
                id: "red".to_owned(),
                color: Color::rgb(255, 0, 0),
            },
            Block::SetStrokeWidth {
                id: "wide".to_owned(),
                width: 3.0,
            },
            Block::Repeat {
                id: "repeat".to_owned(),
                count: 2,
                blocks: vec![Block::Forward {
                    id: "repeat-forward".to_owned(),
                    distance: 2.0,
                }],
            },
            Block::Clear {
                id: "clear".to_owned(),
            },
            Block::Wait {
                id: "wait".to_owned(),
                duration_ms: 25,
            },
        ]);

        let first = interpret_program(&block_program)?;
        let second = interpret_program(&block_program)?;
        assert_eq!(first, second);
        assert_eq!(first.steps.len(), 9);
        assert!(first.steps[1].draw_line.is_none());
        assert_eq!(first.steps[5].block_id, "repeat-forward");
        assert_eq!(first.steps[6].block_id, "repeat-forward");
        assert_eq!(first.steps[8].duration_ms, 25);
        assert_eq!(first.final_state.color, Color::rgb(255, 0, 0));
        assert!((first.final_state.stroke_width - 3.0).abs() < f64::EPSILON);

        Ok(())
    }

    #[test]
    fn renderer_draws_png_respects_pen_up_clear_and_is_deterministic() -> Result<(), EngineError> {
        let drawing = program(vec![Block::Forward {
            id: "line".to_owned(),
            distance: 25.0,
        }]);
        let image = render_program_image(&drawing)?;
        assert!(count_non_white(&image) > 0);

        let hidden = program(vec![
            Block::PenUp {
                id: "pen-up".to_owned(),
            },
            Block::Forward {
                id: "hidden".to_owned(),
                distance: 25.0,
            },
        ]);
        let hidden_image = render_program_image(&hidden)?;
        assert_eq!(count_non_white(&hidden_image), 0);

        let cleared = program(vec![
            Block::Forward {
                id: "line".to_owned(),
                distance: 25.0,
            },
            Block::Clear {
                id: "clear".to_owned(),
            },
        ]);
        let cleared_image = render_program_image(&cleared)?;
        assert_eq!(count_non_white(&cleared_image), 0);

        let first_png = render_program_png(&drawing)?;
        let second_png = render_program_png(&drawing)?;
        assert_eq!(first_png, second_png);
        assert!(first_png.starts_with(b"\x89PNG\r\n\x1a\n"));

        Ok(())
    }

    #[test]
    fn similarity_scores_identical_different_resized_and_empty() -> Result<(), EngineError> {
        let white = RgbaImage::from_pixel(4, 4, DEFAULT_BACKGROUND);
        let mut black = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        assert!((pixel_similarity_images(&white, &white) - 1.0).abs() < f64::EPSILON);
        assert!(pixel_similarity_images(&white, &black) < 0.4);

        let resized = RgbaImage::from_pixel(2, 2, DEFAULT_BACKGROUND);
        assert!((pixel_similarity_images(&white, &resized) - 1.0).abs() < f64::EPSILON);

        black.put_pixel(0, 0, DEFAULT_BACKGROUND);
        let white_png = encode_png(&white)?;
        let black_png = encode_png(&black)?;
        assert!(pixel_similarity_png_bytes(&white_png, &black_png)? < 1.0);
        assert_eq!(pixel_similarity_png_bytes(&[], &white_png)?, 0.0);

        Ok(())
    }
}
