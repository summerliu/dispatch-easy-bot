import { NextResponse } from "next/server";
import { Bot } from "grammy";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: Request) {
  try {
    const { title, assigneeId, dueAt } = await req.json();

    // 1. 檢查環境變數
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
      return NextResponse.json({ 
        success: false, 
        error: "伺服器環境變數設定不完整，請檢查 .env.local 檔案是否放對位置。" 
      }, { status: 500 });
    }

    // 2. 初始化工具
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

    // 3. 寫入工單到資料庫
    const { data: task, error: dbError } = await supabase
      .from("tasks")
      .insert({ title, assignee_id: Number(assigneeId), due_at: dueAt, status: "pending" })
      .select()
      .single();

    if (dbError || !task) {
      return NextResponse.json({ success: false, error: `資料庫寫入失敗: ${dbError?.message}` }, { status: 400 });
    }

    // 4. 查詢該員工的 Telegram ID
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("telegram_id, name")
      .eq("id", Number(assigneeId))
      .single();

    // 5. 嘗試發送 Telegram 推播
    let tgMessageSent = false;
    let tgErrorLog = "";

    if (user && user.telegram_id) {
      try {
        await bot.api.sendMessage(
          Number(user.telegram_id),
          `📌 *【新工單指派】*\n\n📝 任務：${title}\n⏳ 截止時間：${dueAt}\n\n請確認是否接受此任務：`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "🟢 接受任務", callback_data: `accept:${task.id}` }]]
            }
          }
        );
        tgMessageSent = true;
      } catch (e: any) {
        tgErrorLog = `Telegram 發送失敗（可能使用者把機器人封鎖或 ID 錯誤）: ${e.message}`;
      }
    } else {
      tgErrorLog = "該員工尚未在 Telegram 機器人完成綁定（找不到 telegram_id）。";
    }

    return NextResponse.json({ 
      success: true, 
      task, 
      tgNotified: tgMessageSent,
      notice: tgErrorLog
    });

  } catch (globalError: any) {
    console.error("API 發生未預期崩潰:", globalError);
    return NextResponse.json({ success: false, error: `伺服器內部錯誤: ${globalError.message}` }, { status: 500 });
  }
}