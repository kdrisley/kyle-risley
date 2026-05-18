/**
 * Tests for the Pong game logic (pong/pong.js).
 *
 * Run:  node --test pong/
 *
 * pong.js is browser code. Its bootstrap is guarded by `typeof document`, so
 * evaluating the raw source in Node skips the DOM setup and leaves the pure
 * physics functions intact. The harness below evaluates the source in a fresh
 * function scope and returns those functions (plus constants) for assertion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'pong.js'), 'utf8');

function loadPong() {
    const factory = new Function(
        SRC +
            '\nreturn { COURT, PADDLE, BALL_RADIUS, WIN_SCORE, BALL_SPEED, ' +
            'BALL_SPEED_MAX, AI_SPEED, reflectOffWall, paddleBounce, ' +
            'computeAITarget, checkScore, isGameOver, serveBall };'
    );
    return factory();
}

const pong = loadPong();

function makePaddle(x, y) {
    return { x: x, y: y, width: pong.PADDLE.width, height: pong.PADDLE.height };
}

describe('reflectOffWall', () => {
    test('bounces off the top wall — vy turns positive', () => {
        const ball = { x: 100, y: pong.BALL_RADIUS - 4, vx: 3, vy: -5 };
        pong.reflectOffWall(ball);
        assert.equal(ball.y, pong.BALL_RADIUS);
        assert.ok(ball.vy > 0, 'vy should point down after a top bounce');
    });

    test('bounces off the bottom wall — vy turns negative', () => {
        const ball = { x: 100, y: pong.COURT.height - pong.BALL_RADIUS + 4, vx: 3, vy: 5 };
        pong.reflectOffWall(ball);
        assert.equal(ball.y, pong.COURT.height - pong.BALL_RADIUS);
        assert.ok(ball.vy < 0, 'vy should point up after a bottom bounce');
    });

    test('leaves a ball away from the walls untouched', () => {
        const ball = { x: 100, y: 250, vx: 3, vy: 5 };
        pong.reflectOffWall(ball);
        assert.deepEqual(ball, { x: 100, y: 250, vx: 3, vy: 5 });
    });
});

describe('paddleBounce', () => {
    test('a center hit on the left paddle sends the ball straight right', () => {
        const paddle = makePaddle(20, 200);
        const ball = { x: 34, y: paddle.y + paddle.height / 2, vx: -6, vy: 0 };
        pong.paddleBounce(ball, paddle, 'left');
        assert.ok(ball.vx > 0, 'ball should travel right off the player paddle');
        assert.ok(Math.abs(ball.vy) < 1e-9, 'a center hit produces no vertical angle');
    });

    test('an edge hit produces a steeper angle than a center hit', () => {
        const paddle = makePaddle(20, 200);
        const center = { x: 34, y: paddle.y + paddle.height / 2, vx: -6, vy: 0 };
        const edge = { x: 34, y: paddle.y + paddle.height, vx: -6, vy: 0 };
        pong.paddleBounce(center, paddle, 'left');
        pong.paddleBounce(edge, paddle, 'left');
        assert.ok(Math.abs(edge.vy) > Math.abs(center.vy), 'edge hit should angle more');
    });

    test('the right paddle sends the ball left', () => {
        const paddle = makePaddle(760, 200);
        const ball = { x: 752, y: paddle.y + paddle.height / 2, vx: 6, vy: 0 };
        pong.paddleBounce(ball, paddle, 'right');
        assert.ok(ball.vx < 0, 'ball should travel left off the cpu paddle');
    });

    test('rebound speed never exceeds the cap', () => {
        const paddle = makePaddle(20, 200);
        const ball = { x: 34, y: paddle.y + 10, vx: -40, vy: 30 };
        pong.paddleBounce(ball, paddle, 'left');
        const speed = Math.hypot(ball.vx, ball.vy);
        assert.ok(speed <= pong.BALL_SPEED_MAX + 1e-9, 'speed should be capped');
    });
});

describe('computeAITarget', () => {
    test('never moves the paddle more than AI_SPEED in one frame', () => {
        const paddle = makePaddle(760, 200);
        for (const ballY of [0, 60, 250, 440, 500]) {
            const ball = { x: 400, y: ballY, vx: 5, vy: 0 };
            const next = pong.computeAITarget(ball, paddle);
            assert.ok(
                Math.abs(next - paddle.y) <= pong.AI_SPEED + 1e-9,
                'step for ballY=' + ballY + ' exceeded AI_SPEED'
            );
        }
    });

    test('chases the ball when it is incoming', () => {
        const paddle = makePaddle(760, 200);
        const ball = { x: 400, y: 480, vx: 5, vy: 2 };
        const next = pong.computeAITarget(ball, paddle);
        assert.ok(next > paddle.y, 'paddle should move down toward a low incoming ball');
    });

    test('drifts toward center when the ball is moving away', () => {
        const high = makePaddle(760, 10);
        const ball = { x: 400, y: 250, vx: -5, vy: 0 };
        const next = pong.computeAITarget(ball, high);
        assert.ok(next > high.y, 'paddle near the top should drift down toward center');
    });

    test('keeps the paddle inside the court', () => {
        const paddle = makePaddle(760, pong.COURT.height - pong.PADDLE.height);
        const ball = { x: 400, y: pong.COURT.height, vx: 5, vy: 0 };
        const next = pong.computeAITarget(ball, paddle);
        assert.ok(next <= pong.COURT.height - pong.PADDLE.height + 1e-9, 'no overflow');
        assert.ok(next >= 0, 'no underflow');
    });
});

describe('checkScore', () => {
    test('a ball past the left edge scores for the cpu', () => {
        assert.equal(pong.checkScore({ x: -pong.BALL_RADIUS - 1, y: 250 }), 'cpu');
    });

    test('a ball past the right edge scores for the player', () => {
        assert.equal(
            pong.checkScore({ x: pong.COURT.width + pong.BALL_RADIUS + 1, y: 250 }),
            'player'
        );
    });

    test('a ball in play scores for nobody', () => {
        assert.equal(pong.checkScore({ x: 400, y: 250 }), null);
    });
});

describe('isGameOver', () => {
    test('is true once a side reaches the win score', () => {
        assert.equal(pong.isGameOver({ player: pong.WIN_SCORE, cpu: 4 }), true);
        assert.equal(pong.isGameOver({ player: 2, cpu: pong.WIN_SCORE }), true);
    });

    test('is false before either side reaches the win score', () => {
        assert.equal(pong.isGameOver({ player: pong.WIN_SCORE - 1, cpu: pong.WIN_SCORE - 1 }), false);
    });
});

describe('serveBall', () => {
    test('launches from center at the configured speed', () => {
        const ball = pong.serveBall(1);
        assert.equal(ball.x, pong.COURT.width / 2);
        assert.equal(ball.y, pong.COURT.height / 2);
        assert.ok(
            Math.abs(Math.hypot(ball.vx, ball.vy) - pong.BALL_SPEED) < 1e-9,
            'serve speed should equal BALL_SPEED'
        );
    });

    test('honors the serve direction', () => {
        assert.ok(pong.serveBall(1).vx > 0, 'direction +1 serves toward the cpu');
        assert.ok(pong.serveBall(-1).vx < 0, 'direction -1 serves toward the player');
    });
});
