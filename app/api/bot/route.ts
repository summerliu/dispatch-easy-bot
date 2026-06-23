import { Bot, webhookCallback } from "grammy";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function createBot() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

  async function getOrCreateUserByUsername(username: string) {
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("binding_code", username)
      .single();

    if (user) return user;

    const { data: newUser } = await supabase
      .from("users")
      .insert({ name: username, binding_code: username, role: "staff" })
      .select()
      .single();

    return newUser;
  }

  async function handleNewTask(ctx: any, fullText: string) {
    const mentionMatch = fullText.match(/\/(?:new|new@\w+)\s+(.*)\s+(?:@)?(\w+)/);
    if (!mentionMatch) {
      return ctx.reply("❌ 格式錯誤！使用範例：\n`/new 維修冷氣 @summerliu` 或 `/new 維修冷氣 summerliu`", { parse_mode: "Markdown" });
    }

    const taskTitle = mentionMatch[1].trim();
    const username = mentionMatch[2].trim();

    const staffUser = await getOrCreateUserByUsername(username);
    if (!staffUser) return ctx.reply("❌ 系統初始化員工資料失敗。");

    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        title: taskTitle,
        assignee_id: staffUser.id,
        status: "active",
      })
      .select()
      .single();

    if (error || !task) {
      return ctx.reply(`❌ 任務建立失敗：${error?.message}`);
    }

    await ctx.reply(
      `📌 *【新任務派發】*\n\n` +
      `📝 任務：${taskTitle}\n` +
      `👤 負責人：@${username}\n\n` +
      `⚡️ 任務已自動生效。請 @${username} 完成任務後，*「回覆」此訊息並上傳完工照片*！`,
      { parse_mode: "Markdown" }
    );
  }

  bot.command("new", async (ctx) => {
    try {
      const text = ctx.match?.trim();
      if (!text) {
        return ctx.reply("❌ 格式錯誤！使用範例：`/new 維修A棟冷氣 @xiaoming`", { parse_mode: "Markdown" });
      }
      await handleNewTask(ctx, `/new ${text}`);
    } catch (err: any) {
      await ctx.reply(`💥 派工發生錯誤：${err.message}`);
    }
  });

  bot.on("message:photo", async (ctx) => {
    try {
      const caption = ctx.message.caption?.trim();
      const replyToMessage = ctx.message?.reply_to_message;

      if (caption && (caption.startsWith("/new ") || caption.startsWith("/new@"))) {
        await handleNewTask(ctx, caption);
        return;
      }

      if (!replyToMessage || !replyToMessage.text) return;

      const taskMatch = replyToMessage.text.match(/📝 任務：(.*)\n/);
      if (!taskMatch) return;
      const taskTitle = taskMatch[1].trim();

      await supabase
        .from("tasks")
        .update({ status: "completed" })
        .eq("title", taskTitle)
        .neq("status", "closed");

      await ctx.reply(
        `📸 *【員工完工回報】*\n\n` +
        `📝 待審核任務：${taskTitle}\n` +
        `請主管確認現場照片。若審核通過，請*「回覆」此條通知*並輸入 \`/ok\` 結案。`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      console.error("處理照片區塊失敗:", err);
    }
  });

  bot.command("tasks", async (ctx) => {
    try {
      const { data: tasks, error } = await supabase
        .from("tasks")
        .select(`
          id,
          title,
          status,
          users ( binding_code )
        `)
        .order("id", { ascending: false })
        .limit(30);

      if (error || !tasks || tasks.length === 0) {
        return ctx.reply("📭 目前資料庫內沒有任何任務紀錄。");
      }

      const activeTasks = tasks.filter(t => t.status === "active");
      const completedTasks = tasks.filter(t => t.status === "completed");
      const closedTasks = tasks.filter(t => t.status === "closed");

      let message = `📊 *【目前全體任務進度清單】*\n\n`;

      message += `⚡️ *執行中任務 (${activeTasks.length})：*\n`;
      if (activeTasks.length === 0) message += `_（無）_\n`;
      else activeTasks.forEach((t: any) => {
        const name = t.users?.binding_code ? `@${t.users.binding_code}` : "未指派";
        message += `• ${t.title} ➔ ${name}\n`;
      });

      message += `\n`;

      message += `📸 *待審核完工 (${completedTasks.length})：*\n`;
      if (completedTasks.length === 0) message += `_（無）_\n`;
      else completedTasks.forEach((t: any) => {
        const name = t.users?.binding_code ? `@${t.users.binding_code}` : "未指派";
        message += `• *${t.title}* ➔ ${name} (等主管回覆 /ok)\n`;
      });

      message += `\n`;

      message += `✅ *已結案任務 (最新5筆)：*\n`;
      if (closedTasks.length === 0) message += `_（無）_\n`;
      else closedTasks.slice(0, 5).forEach((t: any) => {
        message += `• ~${t.title}~\n`;
      });

      await ctx.reply(message, { parse_mode: "Markdown" });
    } catch (err: any) {
      await ctx.reply(`💥 無法讀取任務列表：${err.message}`);
    }
  });

  bot.command("delete", async (ctx) => {
    try {
      const taskTitle = ctx.match?.trim();
      if (!taskTitle) {
        return ctx.reply("❌ 格式錯誤！請輸入 `/delete [任務名稱]`\n例如：`/delete test`", { parse_mode: "Markdown" });
      }

      const { data: targetTask } = await supabase
        .from("tasks")
        .select("id")
        .eq("title", taskTitle)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!targetTask) {
        return ctx.reply(`❌ 找不到名為「${taskTitle}」的任務，無法刪除。`);
      }

      const { error } = await supabase
        .from("tasks")
        .delete()
        .eq("id", targetTask.id);

      if (error) return ctx.reply(`❌ 刪除失敗：${error.message}`);

      await ctx.reply(`🗑️ *【管理員刪除任務】*\n\n任務「*${taskTitle}*」已被成功從系統刪除！`, {
        parse_mode: "Markdown"
      });
    } catch (err: any) {
      await ctx.reply(`💥 刪除任務發生錯誤：${err.message}`);
    }
  });

  bot.command("ok", async (ctx) => {
    try {
      const textArg = ctx.match?.trim();
      const replyToMessage = ctx.message?.reply_to_message;

      let taskTitle = "";

      if (textArg) {
        taskTitle = textArg;
      } else if (replyToMessage && replyToMessage.text) {
        const taskMatch = replyToMessage.text.match(/📝 待審核任務：(.*)\n/);
        if (taskMatch) {
          taskTitle = taskMatch[1].trim();
        }
      }

      if (!taskTitle) {
        const { data: fallbackTask } = await supabase
          .from("tasks")
          .update({ status: "closed" })
          .eq("status", "completed")
          .order("id", { ascending: false })
          .limit(1)
          .select()
          .maybeSingle();

        if (fallbackTask) {
          return ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${fallbackTask.title}*」已順利結案！`);
        }
        return ctx.reply("❌ 無法識別結案目標。請回覆完工通知輸入 `/ok`，或直接輸入 `/ok [任務名稱]`。");
      }

      const { data: targetTask } = await supabase
        .from("tasks")
        .select("id")
        .eq("title", taskTitle)
        .neq("status", "closed")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!targetTask) {
        return ctx.reply(`❌ 結案失敗，未找到名為「${taskTitle}」的未結案任務。`);
      }

      const { data: finalTask, error } = await supabase
        .from("tasks")
        .update({ status: "closed" })
        .eq("id", targetTask.id)
        .select()
        .single();

      if (error || !finalTask) {
        return ctx.reply(`❌ 變更任務狀態失敗：${error?.message}`);
      }

      await ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${finalTask.title}*」已由主管確認通過，順利結案！`, {
        parse_mode: "Markdown"
      });
    } catch (err: any) {
      await ctx.reply(`💥 結案發生錯誤：${err.message}`);
    }
  });

  return bot;
}

let botInstance: Bot | null = null;

export async function POST(req: Request) {
  if (!botInstance) botInstance = createBot();
  return webhookCallback(botInstance, "std/http")(req);
}
