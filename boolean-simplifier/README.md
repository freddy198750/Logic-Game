# Boolean Simplifier Web

เว็บย่อสมการ Boolean ที่รองรับทั้งการพิมพ์สูตรและแนบรูปเพื่อ OCR แล้วแก้สูตรก่อนย่อ

## ฟีเจอร์

- UI responsive ใช้ได้บนมือถือและคอม
- แนบ JPG / PNG หรือเปิดกล้องมือถือจาก file input
- OCR ด้วย Tesseract.js ทำงานใน browser
- OCR ขอข้อมูลตำแหน่งตัวอักษร (blocks/symbols) แล้วสแกนพิกเซลหาเส้น Bar เหนือตัวอักษรเพื่อแปลงเป็น `BAR(...)` อัตโนมัติ (Beta)
- รูปที่มีหลายข้อจะแยกเป็นหลายสมการ และกดย่อทั้งหมดได้ในครั้งเดียว
- แก้ข้อความที่ OCR อ่านได้ก่อนกดย่อ
- แถบปุ่มสัญลักษณ์สำหรับ OR, AND, NOT, XOR, XNOR, BAR และวงเล็บ
- ย่อด้วย Truth Table + Quine–McCluskey และเลือก cover ที่มีจำนวนพจน์น้อยที่สุด โดยใช้จำนวน literal เป็นตัวตัดสินกรณีเสมอกัน
- มี regression guard ตัดพจน์ SOP ที่เกินแต่ไม่เปลี่ยน truth table เพื่อแก้กรณี essential prime implicant ถูกเลือกเกิน
- รองรับสูงสุด 8 ตัวแปรต่อสูตร

## Syntax ที่รองรับ

| ความหมาย | เขียนได้ |
|---|---|
| OR | `A+B`, `A|B`, `A ∨ B`, `A OR B` |
| AND | `A*B`, `A.B`, `A·B`, `A&B`, `A ∧ B`, `AB`, `A AND B` |
| NOT | `A'`, `!A`, `~A`, `¬A`, `A̅`, `BAR(A)`, `NOT A` |
| BAR ยาว | `BAR(A+B)` หรือ `(A+B)'` |
| XOR | `A ⊕ B`, `A ^ B`, `A XOR B` |
| XNOR | `A ⊙ B`, `A XNOR B` |
| Assignment / ชื่อตัวออก | `X = A+B`, `Z = A.B` (โปรแกรมย่อเฉพาะด้านขวา) |

### ตัวแปร

ไม่ล็อกเฉพาะ A/B สามารถใช้ได้ เช่น:

- ตัวเดียว: `X`, `Y`, `Z`, `C`, `D`
- มีตัวเลข: `Q1`, `Q2`, `Input1`
- ชื่อหลายตัวอักษร: `Sensor`, `Enable`, `Input_A`
- ชื่อพิมพ์ใหญ่หลายตัว เช่น `INPUT` ให้ครอบด้วยวงเล็บเหลี่ยม: `[INPUT]`

เหตุผลคือรูปแบบ Boolean แบบดั้งเดิม `AB` ถูกตีความว่า `A AND B` ดังนั้น `[INPUT]` ใช้เพื่อบอกโปรแกรมว่า INPUT คือชื่อตัวแปรเดียว

## ตัวอย่าง

| Input | Output |
|---|---|
| `Z = A.B + A.B'` | `Z = A` |
| `CD + CD'` | `C` |
| `X ⊕ Y` | `X'·Y + X·Y'` |
| `BAR(X+Y)` | `X'·Y'` |
| `Sensor*Enable + Sensor*Enable'` | `Sensor` |
| `[INPUT]*Q1 + [INPUT]*Q1'` | `[INPUT]` |
| `A + A'` | `1` |
| `A*A'` | `0` |

## เรื่อง Bar / เส้นขีดบน

สำหรับตัวแปรเดียว สามารถ paste ตัวอักษรที่มี combining overline เช่น `X̅` ได้ หรือใช้ `X'` ซึ่งอ่านง่ายกว่า

สำหรับ Bar ที่ครอบทั้งสมการ เช่นเส้นอยู่เหนือ `X+Y` ให้พิมพ์:

```text
BAR(X+Y)
```

ซึ่งเท่ากับ:

```text
(X+Y)'
```

บนหน้าเว็บมีปุ่ม BAR ที่จะใส่ `BAR()` แล้ววาง cursor ไว้ตรงกลางให้พิมพ์สูตรได้ทันที

## Multi-exercise OCR

ถ้ารูปมีหลายข้อ เช่น `1. X = ...`, `2. Z = ...` โปรแกรมจะเก็บบรรทัดแยกกันและเมื่อกด **ย่อสมการ** จะสร้างผลลัพธ์หลายข้อในแผงเดียว OCR ที่ตัดสมการเป็นบรรทัดต่อเนื่องจะพยายามนำบรรทัดที่ขึ้นต้นด้วย operator มาต่อกับข้อก่อนหน้า

## BAR detector (Beta)

ขั้นตอนคร่าว ๆ:

1. ปรับขนาดรูปให้อยู่ในช่วงที่ OCR อ่านง่าย
2. ใช้ Tesseract.js แบบ `blocks` เพื่อได้ line/word/symbol bounding boxes
3. สแกนบริเวณด้านบนของแต่ละบรรทัดเพื่อหา detached horizontal runs
4. จับช่วง x ของเส้น Bar กับอักขระด้านล่าง
5. แปลงเป็น `BAR(...)` ก่อนส่งเข้า parser

ตัวอย่าง: เส้นยาวเหนือ `A+B` จะถูกพยายามแปลงเป็น `BAR(A+B)` ส่วนเส้นแยกเหนือ `A`, `B`, `C` จะกลายเป็น `BAR(A)BAR(B)BAR(C)` และช่วงที่ซ้อนกันจะถูกเก็บเป็น `BAR(BAR(...))` เมื่อ geometry รองรับ

ข้อจำกัด: ภาพเอียง/เบลอ เส้นตาราง เส้น Bar ที่ติดตัวอักษรมาก หรือ OCR ที่จับ bounding box ผิด อาจทำให้ Bar ตรวจผิดได้ จึงต้องตรวจสูตรที่แปลงแล้วก่อนย่อเสมอ นอกจากนี้ OCR อาจสับสนตัวอักษรหน้าตาคล้ายกัน เช่น `C/O/Q` ซึ่งระบบไม่เดาแก้เองเพราะโปรแกรมรองรับชื่อตัวแปรอิสระ

## Validation

แกน simplifier ถูกทดสอบกับกฎ Boolean พื้นฐาน 21 ข้อ (identity, null, idempotent, complement, commutative, associative, distributive, absorption และ De Morgan) โดยทั้งสองฝั่งของแต่ละกฎให้ผลเท่ากันครบ 21/21 กรณี

มี regression test สำหรับสูตรที่เคยได้พจน์เกิน:

```text
A'B'C' + A'BC + ABC + AB'C' + AB'C
```

ผลที่ต้องได้คือ:

```text
B'·C' + B·C + A·B'
```

โดยไม่มีพจน์ `A·C` ที่ไม่จำเป็น

## วิธีเปิดใช้งาน

โปรเจกต์เป็น static web ไม่ต้องติดตั้ง Python หรือ Node.js

เปิด `index.html` ใน browser ได้เลย แต่ OCR โหลด Tesseract.js จาก CDN จึงต้องเชื่อมต่ออินเทอร์เน็ต

ถ้า repository เปิด GitHub Pages อยู่ สามารถเข้า path `/boolean-simplifier/` ใต้เว็บไซต์ของ repository ได้

## โครงสร้าง

```text
boolean-simplifier/
├── index.html
├── styles.css
├── v3.css        # UI สำหรับ batch result / OCR Bar Beta
├── app.js        # parser/simplifier หลัก
├── v3.js         # multi-exercise + OCR Bar detector + regression guard
└── README.md
```

## Privacy

ตัวโปรเจกต์ไม่มี backend ของตัวเอง การประมวลผลสูตรและการเรียก Tesseract.js เกิดจากหน้าเว็บใน browser ของผู้ใช้
