import { ToolCatalog } from '@aotui/sdk';
import { terminalTools } from './TerminalTools.js';
export function RootView() {
    return <section>
        <h1>Terminal App - Application Instruction</h1>
        <h2>What it is</h2><p>A multi-terminal shell application with command history, current working directories and output tails.</p>
        <h2>How to use</h2><ol>
            <li>Start in TerminalConsole with new_terminal_and_send_command.</li>
            <li>Read the new Terminal View for command status, exit code and output.</li>
            <li>Use terminal_id from the intended Terminal View to run another command, expand output or close that session.</li>
        </ol>
        <p>A command-start receipt means the shell process was started. Read its status, exit code and output in the Terminal View to determine completion.</p>
        <h2>Views</h2>
        <h3>TerminalConsole</h3><p>Shows the project path and current terminals. new_terminal_and_send_command requires a shell command and opens a Terminal View.</p>

        <h3>Terminal</h3><p>Shows one session's working directory, command history, execution status and visible output.</p>

        <h4>Tool Preconditions</h4><ul>
            <li>send_command_to_exist_terminal requires a live, idle terminal_id and a command. If the selected terminal is busy, wait for it to finish.</li>
            <li>load_more_output requires a live terminal_id and a positive integer tail_lines; it expands that terminal's visible output.</li>
            <li>close_terminal closes the selected terminal and requests termination of its active command. A closed terminal_id is rejected.</li>
        </ul>
        <p>Terminal tools are registered once for the Terminal View Type. Their terminal_id parameter selects a live Terminal listed here and shown in its View.</p>
        <p>The project path sets the initial working directory and limits the built-in cd command. Shell commands run with the Host's operating-system permissions.</p>
    <ToolCatalog definition={terminalTools} />
        </section>;
}
