-- SignalREACH (installer/cachyos-lazyvim) — written by installer/cachyos-lazyvim/install.sh.
-- Chat with the REACH endpoint from LazyVim. Needs the `reach` command in PATH
-- (installed to ~/.local/bin by the same installer) and the endpoint client
-- service running on 127.0.0.1:20777.
--
-- Keymaps (change them if they clash with your config):
--   <leader>ac  open the interactive REACH chat in a terminal
--   <leader>af  ask a question about the current buffer
--   <leader>as  ask a question about the visual selection (line-based)

local function open_reach(args)
  if Snacks and Snacks.terminal then
    Snacks.terminal.open(args, { cwd = vim.fn.getcwd(), interactive = true })
    return
  end
  -- Fallback when snacks.nvim is unavailable: a plain split terminal.
  vim.cmd.enew()
  vim.fn.termopen(args)
  vim.cmd.startinsert()
end

local function ask(question, context)
  if not question or question == "" then
    return
  end
  local payload = question
  if context and context ~= "" then
    payload = question .. "\n\nContext:\n```\n" .. context .. "\n```"
  end
  open_reach({ "reach", "ask", payload })
end

local function ask_buffer()
  local path = vim.api.nvim_buf_get_name(0)
  local name = path ~= "" and vim.fn.fnamemodify(path, ":.") or "[no file]"
  local text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n")
  vim.ui.input({ prompt = "REACH ask about " .. name .. ": " }, function(question)
    ask(question, "File: " .. name .. "\n" .. text)
  end)
end

local function ask_selection()
  vim.ui.input({ prompt = "REACH ask about selection: " }, function(question)
    -- The '< / '> marks hold the selection the moment visual mode ends (the
    -- prompt above exits it), so this works from a visual-mode mapping.
    local start_line = vim.fn.getpos("'<")[2]
    local end_line = vim.fn.getpos("'>")[2]
    if start_line < 1 or end_line < start_line then
      ask(question, "")
      return
    end
    local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
    ask(question, table.concat(lines, "\n"))
  end)
end

return {
  {
    "folke/snacks.nvim",
    keys = {
      { "<leader>ac", function() open_reach({ "reach", "chat" }) end, desc = "REACH: chat" },
      { "<leader>af", function() ask_buffer() end, desc = "REACH: ask about this file" },
      { "<leader>as", function() ask_selection() end, mode = { "v" }, desc = "REACH: ask about selection" },
    },
  },
}
