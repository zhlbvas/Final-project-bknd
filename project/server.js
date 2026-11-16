
require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./db");
const bcrypt = require("bcrypt");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

// Настройки Render
if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

// Настройки EJS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Подключение файлов
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Настройки сессии
app.use(session({
    name: "astana-guide.sid",
    secret: process.env.SESSION_SECRET || "local-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 2 * 60 * 60 * 1000
    }
}));

// Проверка авторизации
app.use((req, res, next) => {
    res.locals.isAdmin = Boolean(req.session.isAdmin);
    next();
});

// Защита страниц администратора
function requireAuth(req, res, next) {
    if (req.session.isAdmin) {
        return next();
    }
    res.redirect("/login");
}

// Защита REST API
function apiRequireAuth(req, res, next) {
    if (req.session.isAdmin) {
        return next();
    }

    res.status(401).json({
        message: "Необходимо войти как администратор."
    });
}

// ==========================================
// ГЛАВНАЯ СТРАНИЦА
// ==========================================

app.get("/", async (req, res) => {
    try {
        const places = await db.getCollection("places")
            .find({})
            .sort({ id: 1 })
            .toArray();

        res.render("index", {
            title: "Тур-гид по Астане",
            places
        });

    } catch (error) {
        console.error("Ошибка главной страницы:", error);

        res.status(500).render("error", {
            message: "Не удалось загрузить достопримечательности."
        });
    }
});

// ==========================================
// АВТОРИЗАЦИЯ
// ==========================================

app.get("/login", (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect("/add");
    }

    res.render("login", {
        title: "Вход администратора",
        error: null
    });
});

app.post("/login", async (req, res) => {
    try {
        const { login, password } = req.body;

        if (!login || !password) {
            return res.status(400).render("login", {
                title: "Вход администратора",
                error: "Введите логин и пароль."
            });
        }

        const correctLogin = login === process.env.ADMIN_LOGIN;

        const correctPassword = process.env.ADMIN_HASH
            ? await bcrypt.compare(password, process.env.ADMIN_HASH)
            : false;

        if (!correctLogin || !correctPassword) {
            return res.status(401).render("login", {
                title: "Вход администратора",
                error: "Неверный логин или пароль."
            });
        }

        req.session.regenerate((error) => {
            if (error) {
                console.error(error);

                return res.status(500).render("login", {
                    title: "Вход администратора",
                    error: "Не удалось выполнить вход."
                });
            }

            req.session.isAdmin = true;

            req.session.save((error) => {
                if (error) {
                    console.error(error);

                    return res.status(500).render("login", {
                        title: "Вход администратора",
                        error: "Ошибка сохранения авторизации."
                    });
                }

                res.redirect("/add");
            });
        });

    } catch (error) {
        console.error("Ошибка авторизации:", error);

        res.status(500).render("login", {
            title: "Вход администратора",
            error: "Произошла ошибка при входе."
        });
    }
});

// Выход администратора
app.post("/logout", (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            return res.status(500).send("Не удалось выйти.");
        }

        res.clearCookie("astana-guide.sid");
        res.redirect("/");
    });
});

// ==========================================
// REST API — GET
// ==========================================

app.get("/api/places", async (req, res) => {
    try {
        const collection = db.getCollection("places");

        const page = Math.max(1, parseInt(req.query.page) || 1);

        const limit = Math.min(
            100,
            Math.max(1, parseInt(req.query.limit) || 10)
        );

        const filter = {};

        if (req.query.category) {
            filter.category = req.query.category;
        }

        const total = await collection.countDocuments(filter);

        const items = await collection
            .find(filter)
            .sort({ id: 1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

        res.status(200).json({
            total,
            page,
            limit,
            items
        });

    } catch (error) {
        console.error("GET API:", error);

        res.status(500).json({
            message: "Не удалось получить достопримечательности."
        });
    }
});

// ==========================================
// REST API — POST
// ==========================================

app.post("/api/places", apiRequireAuth, async (req, res) => {
    try {
        const {
            title,
            description,
            category,
            time,
            image
        } = req.body;

        if (
            typeof title !== "string" ||
            title.trim().length < 8 ||
            typeof description !== "string" ||
            description.trim().length < 10 ||
            typeof category !== "string" ||
            !category.trim() ||
            typeof time !== "string" ||
            !time.trim()
        ) {
            return res.status(400).json({
                message: "Проверьте заполнение обязательных полей."
            });
        }

        const collection = db.getCollection("places");

        const lastPlace = await collection
            .find({})
            .sort({ id: -1 })
            .limit(1)
            .toArray();

        const newId = lastPlace.length
            ? lastPlace[0].id + 1
            : 1;

        const newPlace = {
            id: newId,
            title: title.trim(),
            description: description.trim(),
            category: category.trim(),
            time: time.trim(),
            image: typeof image === "string" ? image : ""
        };

        await collection.insertOne(newPlace);

        res.status(201).json({
            message: "Достопримечательность успешно добавлена.",
            item: newPlace
        });

    } catch (error) {
        console.error("POST API:", error);

        res.status(500).json({
            message: "Не удалось добавить достопримечательность."
        });
    }
});

// ==========================================
// REST API — PUT
// ==========================================

app.put("/api/places/:id", apiRequireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({
                message: "Некорректный ID."
            });
        }

        const {
            title,
            description,
            category,
            time,
            image
        } = req.body;

        const updates = {};

        if (title !== undefined) {
            if (typeof title !== "string" || title.trim().length < 8) {
                return res.status(400).json({
                    message: "Название должно содержать минимум 8 символов."
                });
            }

            updates.title = title.trim();
        }

        if (description !== undefined) {
            if (typeof description !== "string" || description.trim().length < 10) {
                return res.status(400).json({
                    message: "Описание должно содержать минимум 10 символов."
                });
            }

            updates.description = description.trim();
        }

        if (category !== undefined) {
            if (typeof category !== "string" || !category.trim()) {
                return res.status(400).json({
                    message: "Укажите категорию."
                });
            }

            updates.category = category.trim();
        }

        if (time !== undefined) {
            if (typeof time !== "string" || !time.trim()) {
                return res.status(400).json({
                    message: "Укажите время посещения."
                });
            }

            updates.time = time.trim();
        }

        if (image !== undefined) {
            if (typeof image !== "string") {
                return res.status(400).json({
                    message: "Некорректное изображение."
                });
            }

            updates.image = image;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                message: "Нет данных для изменения."
            });
        }

        const result = await db.getCollection("places").updateOne(
            { id },
            { $set: updates }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                message: "Достопримечательность не найдена."
            });
        }

        res.status(200).json({
            message: "Достопримечательность успешно изменена."
        });

    } catch (error) {
        console.error("PUT API:", error);

        res.status(500).json({
            message: "Не удалось изменить достопримечательность."
        });
    }
});

// ==========================================
// REST API — DELETE
// ==========================================

app.delete("/api/places/:id", apiRequireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({
                message: "Некорректный ID."
            });
        }

        const result = await db.getCollection("places").deleteOne({
            id
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                message: "Достопримечательность не найдена."
            });
        }

        res.status(200).json({
            message: "Достопримечательность успешно удалена."
        });

    } catch (error) {
        console.error("DELETE API:", error);

        res.status(500).json({
            message: "Не удалось удалить достопримечательность."
        });
    }
});

// ==========================================
// ДОБАВЛЕНИЕ ЧЕРЕЗ САЙТ
// ==========================================

app.get("/add", requireAuth, (req, res) => {
    res.render("add", {
        title: "Добавить достопримечательность",
        errors: [],
        formData: {}
    });
});

app.post("/add", requireAuth, async (req, res) => {
    try {
        const {
            title,
            description,
            category,
            time
        } = req.body;

        const errors = [];

        if (!title || title.trim().length < 8) {
            errors.push("Название должно содержать минимум 8 символов.");
        }

        if (!description || description.trim().length < 10) {
            errors.push("Описание должно содержать минимум 10 символов.");
        }

        if (!category) {
            errors.push("Выберите категорию.");
        }

        if (!time) {
            errors.push("Укажите время посещения.");
        }

        const formData = {
            title,
            description,
            category,
            time
        };

        if (errors.length > 0) {
            return res.status(400).render("add", {
                title: "Добавить достопримечательность",
                errors,
                formData
            });
        }

        const collection = db.getCollection("places");

        const lastPlace = await collection
            .find({})
            .sort({ id: -1 })
            .limit(1)
            .toArray();

        const newId = lastPlace.length
            ? lastPlace[0].id + 1
            : 1;

        await collection.insertOne({
            id: newId,
            title: title.trim(),
            description: description.trim(),
            category,
            time,
            image: req.body.image || ""
        });

        res.redirect("/");

    } catch (error) {
        console.error("Ошибка добавления:", error);

        res.status(500).render("error", {
            message: "Не удалось добавить достопримечательность."
        });
    }
});

// ==========================================
// СТРАНИЦА ДОСТОПРИМЕЧАТЕЛЬНОСТИ
// ==========================================

app.get("/place/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        const place = await db.getCollection("places").findOne({
            id
        });

        if (!place) {
            return res.status(404).render("404", {
                title: "Страница не найдена"
            });
        }

        res.render("place", {
            title: place.title,
            place
        });

    } catch (error) {
        console.error("Ошибка загрузки места:", error);

        res.status(500).render("error", {
            message: "Не удалось загрузить страницу."
        });
    }
});

// ==========================================
// О ПРОЕКТЕ
// ==========================================

app.get("/about", (req, res) => {
    res.render("about", {
        title: "О проекте"
    });
});

// ==========================================
// 404
// ==========================================

app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({
            message: "API-маршрут не найден."
        });
    }

    res.status(404).render("404", {
        title: "Страница не найдена"
    });
});

// ==========================================
// ОБРАБОТКА ОШИБОК
// ==========================================

app.use((error, req, res, next) => {
    console.error("Ошибка сервера:", error);

    if (req.path.startsWith("/api/")) {
        return res.status(500).json({
            message: "Произошла внутренняя ошибка сервера."
        });
    }

    res.status(500).render("error", {
        message: "Произошла внутренняя ошибка сервера."
    });
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================

async function startServer() {
    try {
        const required = [
            "MONGODB_URI",
            "ADMIN_LOGIN",
            "ADMIN_HASH",
            "SESSION_SECRET"
        ];

        const missing = required.filter(
            key => !process.env[key]
        );

        if (missing.length > 0) {
            throw new Error(
                "Не заданы переменные: " + missing.join(", ")
            );
        }

        await db.connect();

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`Сервер запущен на порту ${PORT}`);
        });

    } catch (error) {
        console.error("Ошибка запуска сервера:", error);
        process.exit(1);
    }
}

startServer();
