/**
 * Workout Coach workflow definition.
 * Demonstrates a real-world state machine using @openclaw-community/workflow-engine.
 */
import { createMachine } from 'xstate'
import { z } from 'zod'
import type { WorkflowDefinition } from '../src/types'

export const workoutCoachWorkflow: WorkflowDefinition = {
  id: 'workout-coach',

  machine: createMachine({
    id: 'workoutCoach',
    initial: 'idle',
    states: {
      idle: {
        on: {
          GET_NEXT_WORKOUT: 'showing_next_workout',
        },
      },
      showing_next_workout: {
        on: {
          START_SESSION: 'workout_started',
          CANCEL: 'cancelled',
        },
      },
      workout_started: {
        on: {
          BEGIN_EXERCISE: 'exercise_active',
          CANCEL: 'cancelled',
        },
      },
      exercise_active: {
        on: {
          LOG_SET: 'set_logged',
          SKIP_EXERCISE: 'exercise_active',
          FINISH: 'workout_completed',
          CANCEL: 'cancelled',
        },
      },
      set_logged: {
        on: {
          LOG_SET: 'set_logged',
          CONTINUE: 'exercise_active',
          FINISH: 'workout_completed',
          CANCEL: 'cancelled',
        },
      },
      workout_completed: {
        type: 'final',
      },
      cancelled: {
        type: 'final',
      },
    },
  }),

  toolsByState: {
    idle: [
      {
        name: 'get_next_workout',
        description: 'Get the next workout in the rotation',
        inputSchema: z.object({}),
        onSuccess: 'GET_NEXT_WORKOUT',
      },
    ],
    showing_next_workout: [
      {
        name: 'get_next_workout',
        description: 'Get the next workout in the rotation',
        inputSchema: z.object({}),
      },
      {
        name: 'start_workout_session',
        description: 'Start a workout session for the given template',
        inputSchema: z.object({
          template_id: z.string(),
          idempotency_key: z.string(),
        }),
        onSuccess: 'START_SESSION',
      },
      {
        name: 'get_current_session',
        description: 'Get the current workout session state',
        inputSchema: z.object({}),
      },
    ],
    workout_started: [
      {
        name: 'get_current_session',
        description: 'Get the current workout session state',
        inputSchema: z.object({}),
      },
      {
        name: 'begin_exercise',
        description: 'Begin the first exercise in the session',
        inputSchema: z.object({}),
        onSuccess: 'BEGIN_EXERCISE',
      },
      {
        name: 'cancel_workout_session',
        description: 'Cancel the current workout session',
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: 'CANCEL',
      },
    ],
    exercise_active: [
      {
        name: 'get_current_session',
        description: 'Get the current workout session state',
        inputSchema: z.object({}),
      },
      {
        name: 'log_set',
        description: 'Log a completed set',
        inputSchema: z.object({
          weight_kg: z.number().positive(),
          reps: z.number().int().positive(),
          rpe: z.number().min(1).max(10).optional(),
          idempotency_key: z.string(),
        }),
        requiresReadAfterWrite: true,
        readTool: 'get_current_session',
        idempotencyKeyTemplate: '{idempotency_key}',
        onSuccess: 'LOG_SET',
      },
      {
        name: 'skip_exercise',
        description: 'Skip the current exercise',
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: 'SKIP_EXERCISE',
      },
      {
        name: 'finish_workout_session',
        description: 'Mark the workout session as completed',
        inputSchema: z.object({}),
        onSuccess: 'FINISH',
      },
      {
        name: 'cancel_workout_session',
        description: 'Cancel the current workout session',
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: 'CANCEL',
      },
    ],
    set_logged: [
      {
        name: 'get_current_session',
        description: 'Get the current workout session state',
        inputSchema: z.object({}),
      },
      {
        name: 'log_set',
        description: 'Log a completed set',
        inputSchema: z.object({
          weight_kg: z.number().positive(),
          reps: z.number().int().positive(),
          rpe: z.number().min(1).max(10).optional(),
          idempotency_key: z.string(),
        }),
        requiresReadAfterWrite: true,
        readTool: 'get_current_session',
        idempotencyKeyTemplate: '{idempotency_key}',
        onSuccess: 'LOG_SET',
      },
      {
        name: 'finish_workout_session',
        description: 'Mark the workout session as completed',
        inputSchema: z.object({}),
        onSuccess: 'FINISH',
      },
      {
        name: 'cancel_workout_session',
        description: 'Cancel the current workout session',
        inputSchema: z.object({
          reason: z.string().optional(),
        }),
        onSuccess: 'CANCEL',
      },
    ],
  },

  promptsByState: {
    idle: 'The user wants to work out. Call get_next_workout to determine what workout is next.',
    showing_next_workout:
      'You have the next workout queued. Confirm with the user then call start_workout_session.',
    workout_started:
      'A session has been created. Call begin_exercise to start the first exercise, or cancel_workout_session to abort.',
    exercise_active:
      'A workout session is active. Log sets using log_set. Always call get_current_session before and after each log_set.',
    set_logged:
      'A set was just logged. Call get_current_session to check if all sets are done for this exercise, then continue or finish.',
    workout_completed: 'The workout is complete. Provide a summary to the user.',
    cancelled: 'The workout was cancelled.',
  },
}
