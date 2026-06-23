import { Bot, webhookCallback } from "grammy";
import { createClient } from "@supabase/supabase-js";

// 1. 初始化工具
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// 輔助函式：從 @username 尋找或建立資料庫使用者
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

// 核心功能：抽取出來的統一派工邏輯（支援純文字或帶圖片派工，並防呆免打 @）
async function handleNewTask(ctx: any, fullText: string) {
  const mentionMatch = fullText.match(/\/(?:new|new@\w+)\s+(.*)\s+(?:@)?(\w+)/);
  if (!mentionMatch) {
    return ctx.reply("❌ 格式錯誤！使用範例：\n`/new 維修冷氣 @summerliu` 或 `/new 維修冷氣 summerliu`", { parse_mode: "Markdown" });
  }

  const taskTitle = mentionMatch[1].trim();
  const username = mentionMatch[2].trim();

  const staffUser = await getOrCreateUserByUsername(username);
  if (!staffUser) return ctx.reply("❌ 系統初始化員工資料失敗。");

  // 建立任務，狀態設為 active
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

// 2-A. 監聽純文字派工 `/new [任務] @群組人`
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

// 2-B. 監聽帶照片的訊息（如果是主管發照片開任務，或者員工回報完工）
bot.on("message:photo", async (ctx) => {
  try {
    const caption = ctx.message.caption?.trim();
    const replyToMessage = ctx.message.reply_to_message;

    // 如果主管是發一張照片，並在照片說明寫了 `/new ...`
    if (caption && (caption.startsWith("/new ") || caption.startsWith("/new@"))) {
      await handleNewTask(ctx, caption);
      return;
    }

    // 員工回報完工邏輯：必須是長按回覆 Bot 訊息上傳照片
    if (!replyToMessage || !replyToMessage.text) return;

    const taskMatch = replyToMessage.text.match(/📝 任務：(.*)\n/);
    if (!taskMatch) return;
    const taskTitle = taskMatch[1].trim();

    // 更新任務狀態為 completed (待審核)
    await supabase
      .from("tasks")
      .update({ status: "completed" })
      .eq("title", taskTitle)
      .neq("status", "closed");

    // 發出完工審核通知
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

// 3. 監聽 `/tasks` 查看目前全部任務進度
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
    else {
      activeTasks.forEach((t: any) => {
        const name = t.users?.binding_code ? `@${t.users.binding_code}` : "未指派";
        message += `• ${t.title} ➔ ${name}\n`;
      });
    }

    message += `\n`;

    message += `📸 *待審核完工 (${completedTasks.length})：*\n`;
    if (completedTasks.length === 0) message += `_（無）_\n`;
    else {
      completedTasks.forEach((t: any) => {
        const name = t.users?.binding_code ? `@${t.users.binding_code}` : "未指派";
        message += `• *${t.title}* ➔ ${name} (等主管回覆 /ok)\n`;
      });
    }

    message += `\n`;

    message += `✅ *已結案任務 (最新5筆)：*\n`;
    if (closedTasks.length === 0) message += `_（無）_\n`;
    else {
      closedTasks.slice(0, 5).forEach((t: any) => {
        message += `• ~${t.title}~\n`;
      });
    }

    await ctx.reply(message, { parse_mode: "Markdown" });
  } catch (err: any) {
    await ctx.reply(`💥 無法讀取任務列表：${err.message}`);
  }
});

// 4. 新增功能：監聽 `/delete [任務名稱]` (主管強制刪除任務，每次清除最新的一筆)
bot.command("delete", async (ctx) => {
  try {
    const taskTitle = ctx.match?.trim();
    if (!taskTitle) {
      return ctx.reply("❌ 格式錯誤！請輸入 `/delete [任務名稱]`\n例如：`/delete test`", { parse_mode: "Markdown" });
    }

    // 先撈出該名稱最新建立的任務 ID
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

    // 精準刪除該筆 ID
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

// 5. 監聽 /ok (主管結案：支援「回覆照片訊息」或「直接輸入名稱強制結案」)
bot.command("ok", async (ctx) => {
  try {
    const textArg = ctx.match?.trim();
    const replyToMessage = ctx.message.reply_to_message;
    
    let taskTitle = "";

    // 招式 A：如果主管在指令後面直接有帶任務名稱 (例如: /ok 123)
    if (textArg) {
      taskTitle = textArg;
    } 
    // 招式 B：如果是長按回覆 Bot 的完工回報訊息
    else if (replyToMessage && replyToMessage.text) {
      const taskMatch = replyToMessage.text.match(/📝 待審核任務：(.*)\n/);
      if (taskMatch) {
        taskTitle = taskMatch[1].trim();
      }
    }

    // 💥 終極 Fallback：如果以上都拿不到名稱，就直接盲撈整個群組最新一筆待審核(completed)的任務
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

    // 根據抓到的 taskTitle，尋找最新建立且未結案的任務進行強力變更
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

// 6. 將 grammY 轉換成 Next.js App Router 的 POST 處理器
export const POST = webhookCallback(bot, "std/http");