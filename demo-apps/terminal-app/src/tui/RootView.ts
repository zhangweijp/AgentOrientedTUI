export const rootBody = `# Terminal App - Application Instruction

## What it is

A multi-terminal shell application with command history, current working directories and output tails.

## How to use

1. Start in TerminalConsole with new_terminal_and_send_command.
2. Read the new Terminal View for command status, exit code and output.
3. Use view_id from the open receipt or intended Terminal View to run another command, expand output or close that session.

A command-start receipt confirms shell startup. Read status, exit code and output in the Terminal View to determine completion.

## Views

### TerminalConsole

The project path and current terminals. new_terminal_and_send_command requires a shell command and opens a Terminal View.

### Terminal

The session's working directory, command history, execution status and visible output.

- send_command_to_exist_terminal requires a live, idle view_id and a command. If the terminal is busy, wait for it to finish.
- load_more_output requires a live view_id and a positive integer tail_lines. It expands the selected terminal's visible output.
- close_terminal closes the selected terminal and terminates its active command.

The TerminalConsole lists session names. Select a live Terminal using its XML view_id. The project path sets the initial working directory and limits the built-in cd command. Shell commands run with the Host's operating-system permissions.
`;
