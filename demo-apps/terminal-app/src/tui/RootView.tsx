export function RootView() {
    return <section data-role="application-instruction">
        <h1>Terminal App - Application Instruction</h1>
        <h2>What it is</h2><p>A multi-terminal shell application with command history, current working directories and output tails.</p>
        <h2>How to use</h2><ol>
            <li>Start in TerminalConsole with new_terminal_and_send_command.</li>
            <li>Read the new Terminal View for command status, exit code and output.</li>
            <li>Use that Terminal's tools to run another command, expand output or close the session. Use terminal_id from the intended Terminal View when calling its tools.</li>
        </ol>
        <p>A command-start receipt means the shell process was started. Read its status, exit code and output in the Terminal View to determine completion.</p>
        <h2>Views</h2>
        <h3>TerminalConsole</h3><p>Shows the project path and current terminals. new_terminal_and_send_command requires a shell command and opens a Terminal View.</p>
        <h4>Available Tools</h4><ul><li>new_terminal_and_send_command</li></ul>
        <h3>Terminal</h3><p>Shows one session's working directory, command history, execution status and visible output.</p>
        <h4>Available Tools</h4><ul><li>send_command_to_exist_terminal</li><li>load_more_output</li><li>close_terminal</li></ul>
        <h4>Tool Preconditions</h4><ul>
            <li>send_command_to_exist_terminal requires a command and is available when this terminal is not running another command.</li>
            <li>load_more_output requires a positive integer tail_lines and expands this terminal's visible output.</li>
            <li>close_terminal closes this terminal and requests termination of its active command. The closed View's tools are no longer valid.</li>
        </ul>
        <p>Available Tools is a static catalog by View Type. Only tools attached to the current context are callable; Terminal tools require a live Terminal View.</p>
        <p>The project path sets the initial working directory and limits the built-in cd operation. Shell commands run with the Host's operating-system permissions.</p>
    </section>;
}
