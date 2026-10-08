"""Creates the 5 fake demo files in demo_inputs/. Run: python make_demo_files.py"""
import os
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

OUT = "demo_inputs"
os.makedirs(OUT, exist_ok=True)


def font(size, bold=False):
    # Windows fonts first, then Pillow's built-in font as a fallback
    for name in (["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


def wrap(draw, text, f, width):
    """Split text into lines that fit inside width pixels."""
    lines, line = [], ""
    for word in text.split():
        test = (line + " " + word).strip()
        if draw.textlength(test, font=f) <= width:
            line = test
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines


def chat():
    img = Image.new("RGB", (800, 420), "#e5ddd5")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 800, 70], fill="#075e54")
    d.text((24, 20), "Physics 101 Group", font=font(28, True), fill="white")
    msg = "guys physics assignment due this friday!! and our presentation is on tuesday 20th"
    f = font(26)
    lines = wrap(d, msg, f, 560)
    h = 50 + 36 * len(lines) + 30
    d.rounded_rectangle([30, 110, 640, 110 + h], radius=18, fill="white")
    d.text((50, 122), "Aarav (classmate)", font=font(20, True), fill="#128c7e")
    for i, line in enumerate(lines):
        d.text((50, 156 + 36 * i), line, font=f, fill="black")
    d.text((560, 110 + h - 30), "9:41 AM", font=font(16), fill="#777777")
    img.save(f"{OUT}/classmate_chat.png")


def poster():
    img = Image.new("RGB", (700, 900), "#1d3557")
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, 660, 860], outline="#f1faee", width=6)
    d.text((350, 170), "Physics", font=font(80, True), fill="#f1faee", anchor="mm")
    d.text((350, 270), "Presentation Day", font=font(56, True), fill="#ffb703", anchor="mm")
    d.text((350, 450), "Tuesday 20 October 2026", font=font(40), fill="white", anchor="mm")
    d.text((350, 520), "10:00 AM", font=font(40), fill="white", anchor="mm")
    d.text((350, 590), "Room 204", font=font(40), fill="white", anchor="mm")
    d.text((350, 780), "All PHYS 101 groups present", font=font(28), fill="#a8dadc", anchor="mm")
    img.save(f"{OUT}/seminar_poster.png")


def paper(filename, text, size=44):
    img = Image.new("RGB", (800, 400), "#fdf6d8")
    d = ImageDraw.Draw(img)
    for y in range(80, 400, 50):  # ruled paper lines
        d.line([0, y, 800, y], fill="#b9d3ee", width=2)
    d.line([70, 0, 70, 400], fill="#f4a3a3", width=2)
    f = font(size)
    for i, line in enumerate(wrap(d, text, f, 680)):
        d.text((90, 90 + 60 * i), line, font=f, fill="#1a1a6e")
    img.save(f"{OUT}/{filename}")


def notice():
    img = Image.new("RGB", (900, 420), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 900, 60], fill="#2b2d42")
    d.text((24, 16), "University Notice Board - Department of Physics", font=font(24, True), fill="white")
    f = font(28)
    text = "Dear students, the Physics Assignment 3 deadline has been extended to Monday, 19 October."
    y = 100
    for line in wrap(d, text, f, 840):
        d.text((30, y), line, font=f, fill="black")
        y += 42
    d.text((30, y + 30), "- Prof. Sharma", font=font(28, True), fill="black")
    img.save(f"{OUT}/prof_notice.png")


def brief():
    c = canvas.Canvas(f"{OUT}/assignment_brief.pdf", pagesize=A4)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 760, "Physics Assignment 3")
    c.setFont("Helvetica", 12)
    lines = [
        "Course: PHYS 101 - Mechanics",
        "Topic: Newton's laws of motion (problems 1 to 10 from Chapter 4).",
        "",
        "Submission deadline: Thursday, 15 October 2026, 11:59 PM",
        "",
        "Upload your answers as one PDF on the student portal.",
    ]
    for i, line in enumerate(lines):
        c.drawString(72, 720 - 20 * i, line)
    c.save()


def schedule():
    """A 3-page PDF, to test multi-page reading."""
    pages = [
        ("PHYS 101 - Mechanics: Semester Schedule", [
            "Department of Physics - Autumn 2026",
            "This schedule lists the key dates for the course. Please read all three pages.",
            "",
            "Lab Report 2 (Projectile Motion) is due on Wednesday, 21 October 2026 at 5:00 PM.",
            "Hand it in at the Physics Lab Office, Room 112.",
        ]),
        ("Mid-semester exam", [
            "The PHYS 101 mid-semester exam takes place on Wednesday, 28 October 2026,",
            "from 9:00 AM to 11:00 AM in Exam Hall B.",
            "Bring your student ID card and a calculator. Phones are not allowed.",
        ]),
        ("Reading week and office hours", [
            "Reading week: there are no lectures from Monday, 2 November to Friday, 6 November 2026.",
            "",
            "Prof. Sharma holds office hours on Thursdays from 2:00 PM to 4:00 PM in Room 305.",
            "Questions about the course: physics.office@example.edu",
        ]),
    ]
    c = canvas.Canvas(f"{OUT}/course_schedule.pdf", pagesize=A4)
    for n, (title, lines) in enumerate(pages, 1):
        c.setFont("Helvetica-Bold", 18)
        c.drawString(72, 760, title)
        c.setFont("Helvetica", 12)
        for i, line in enumerate(lines):
            c.drawString(72, 724 - 20 * i, line)
        c.setFont("Helvetica", 9)
        c.drawString(72, 40, f"PHYS 101 schedule - page {n} of {len(pages)}")
        c.showPage()
    c.save()


if __name__ == "__main__":
    chat()
    brief()
    schedule()
    poster()
    paper("note.png", "Ask Ram for the presentation slides")
    notice()
    print("Created files in", OUT)
