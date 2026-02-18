from flask import Flask
from config import Config
from models.database import init_db
from routes.webhook import webhook_bp
from routes.api import api_bp
from routes.pages import pages_bp


def create_app():
    app = Flask(__name__)
    app.secret_key = Config.SECRET_KEY

    init_db()

    app.register_blueprint(webhook_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(pages_bp)

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=Config.PORT, debug=True)
