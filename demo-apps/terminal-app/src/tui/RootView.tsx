export function RootView() {
    return <section data-role="application-instruction">
        <h1>Terminal Application Instruction</h1>
        <p>Open a terminal from TerminalConsole. Each Terminal View owns its command, output and close tools.</p>
        <p>A command-start receipt means the shell process was started. Read its status, exit code and output in the Terminal View to determine completion.</p>
        <p>Use load_more_output on that Terminal to extend the visible output. A closed Terminal's tools are no longer valid.</p>
        <p>The project path sets the initial working directory and limits the built-in cd operation. Shell commands run with the Host's operating-system permissions.</p>
    </section>;
}
