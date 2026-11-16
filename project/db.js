
const path = require("path");

// Загружаем .env из папки project
require("dotenv").config({
    path: path.join(__dirname, ".env.example"),
});

const { MongoClient } = require("mongodb");

// Проверяем наличие ссылки MongoDB
if (!process.env.MONGODB_URI) {
    throw new Error(
        "MONGODB_URI не найден! Проверь файл .env в папке project"
    );
}

const client = new MongoClient(process.env.MONGODB_URI);

let database = null;

// Подключение к MongoDB Atlas
async function connect() {
    if (database) {
        return database;
    }

    try {
        await client.connect();

        database = client.db("astana_guide");

        console.log("Облачная база данных подключена");

        return database;
    } catch (error) {
        console.error("Ошибка подключения к MongoDB:", error.message);
        throw error;
    }
}

// Получение коллекции
function getCollection(name) {
    if (!database) {
        throw new Error("Сначала подключитесь к MongoDB!");
    }

    return database.collection(name);
}

// Закрытие подключения
async function close() {
    await client.close();
    database = null;
}

module.exports = {
    connect,
    getCollection,
    close
};
